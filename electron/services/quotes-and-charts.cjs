"use strict";
// 从 electron/services.cjs 提取（2026-11-15 审核 P0-2b 拆分）。
// services.cjs 通过顶部解构回本模块并继续按原契约 re-export，勿在这里引入
// 对 services.cjs 的反向依赖。
// 同花顺免费网关的个股报价与日K线（不需要 QuantAPI Token），以及三路行情的健康度/熔断。
const thsFreeMarket = require("../ths-free-market.cjs");;
const { thsProviderError } = require("../ths-token-manager.cjs");
const { classifyEvent } = require("../news-service.cjs");
const { BoundedCache, credentialFingerprint } = require("../bounded-cache.cjs");
const { buildQuoteConsensus, collectAuxiliarySources, tencentQuote } = require("../data-federation.cjs");
const { semanticKey } = require("../service-runtime.cjs");
const { shanghaiClock } = require("../trend-trading-calendar.cjs");
const { createFuyaoClient } = require("../fuyao-client.cjs");
const _backtest = require("./backtest.cjs");
const { marketSourceHealth, EAST_HISTORY, THS_BASE, QUOTE_SOURCE_LABELS, dailyBarCalendar } = _backtest;
function chainShouldStop(...args) { return _backtest.chainShouldStop(...args); }
function validateHistoryRows(...args) { return _backtest.validateHistoryRows(...args); }
function eastmoneyKlineRow(...args) { return _backtest.eastmoneyKlineRow(...args); }
function tencentHistory(...args) { return _backtest.tencentHistory(...args); }
function sinaKline(...args) { return _backtest.sinaKline(...args); }
function withThsToken(...args) { return _backtest.withThsToken(...args); }
function extractThsTable(...args) { return _backtest.extractThsTable(...args); }
function finiteOrNull(...args) { return _backtest.finiteOrNull(...args); }
function missingMonitorQuoteFields(...args) { return _backtest.missingMonitorQuoteFields(...args); }
function knownIndustry(...args) { return _backtest.knownIndustry(...args); }
function rememberIndustry(...args) { return _backtest.rememberIndustry(...args); }
function eastHistoryCached(...args) { return _backtest.eastHistoryCached(...args); }
function isRiskStockName(...args) { return _backtest.isRiskStockName(...args); }
function eastQuote(...args) { return _backtest.eastQuote(...args); }
function trackedThsFreeQuote(...args) { return _backtest.trackedThsFreeQuote(...args); }
function marketQuoteChain(...args) { return _backtest.marketQuoteChain(...args); }
function publicQuoteWithFallback(...args) { return _backtest.publicQuoteWithFallback(...args); }
function normalizeTencentQuote(...args) { return _backtest.normalizeTencentQuote(...args); }
const _runtime = require("./runtime.cjs");
const { fuyao, serviceRuntime, chartCache, stockIndustryIndex, federationCache, chartRuntime } = _runtime;
function trackServiceRequest(...args) { return _runtime.trackServiceRequest(...args); }
function serviceSignal(...args) { return _runtime.serviceSignal(...args); }
function fetchJson(...args) { return _runtime.fetchJson(...args); }
function isAStockCode(...args) { return _runtime.isAStockCode(...args); }
function toSecurity(...args) { return _runtime.toSecurity(...args); }
const _limit_pool = require("./limit-pool.cjs");
function topicPoolForDate(...args) { return _limit_pool.topicPoolForDate(...args); }
function thsAllAHistory(...args) { return _limit_pool.thsAllAHistory(...args); }
const _sectors = require("./sectors.cjs");
function returnFor(...args) { return _sectors.returnFor(...args); }
function withSingleFlightCache(...args) { return _sectors.withSingleFlightCache(...args); }

const marketEmotionCache = { value: null, expiresAt: 0, promise: null };

function getMarketSourceHealth() {
  return {
    checkedAt: new Date().toISOString(),
    quotes: marketSourceHealth.snapshot([...(fuyao.configured() ? ["fuyao"] : []), "ths_free", "eastmoney", "tencent"]),
    history: marketSourceHealth.snapshot([...(fuyao.configured() ? ["fuyao_history"] : []), "ths_free_history", "eastmoney_history", "tencent_history"])
  };
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
        amount: row.amount !== null && row.amount !== undefined && row.amount !== "" && Number.isFinite(Number(row.amount)) ? Number(row.amount) : null,
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
      current.amount !== null && row.amount !== null && row.amount !== undefined && row.amount !== "" && Number.isFinite(Number(row.amount))
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
    const lines = json?.data?.klines;
    const rows = validateHistoryRows(
      Array.isArray(lines) ? lines.filter((line) => typeof line === "string").map(eastmoneyKlineRow) : [],
      { source: "eastmoney", preserveTime: !["101", "102", "103"].includes(klt), requireRecent: false }
    );
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

function firstValue(table, keys) {
  for (const key of keys) {
    const value = table[key];
    if (Array.isArray(value) && value.length) return value[value.length - 1];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function parseThsSuspendedStatus(status) {
  if (typeof status === "boolean") return status;
  const text = String(status || "").trim();
  if (!text) return null;
  if (/^(?:suspended|delisted|halted)$/i.test(text) || /停牌|暂停交易|暂停上市/.test(text)) return true;
  if (/^(?:trading|open|closed|normal)$/i.test(text) || /交易|竞价|盘中|闭市|收盘|休市|午间|午休|未开盘|盘后|正常|开市/.test(text)) return false;
  return null;
}

function normalizeThsQuoteAt(value) {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  const text = String(value || "").trim();
  if (!text) return "";
  if (/^\d{14}$/.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}T${text.slice(8, 10)}:${text.slice(10, 12)}:${text.slice(12, 14)}+08:00`;
  }
  const localMatch = text.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
  if (localMatch) {
    const timePart = localMatch[2].length === 5 ? `${localMatch[2]}:00` : localMatch[2];
    return `${localMatch[1]}T${timePart}+08:00`;
  }
  if (/(?:Z|[+-]\d{2}:\d{2})$/.test(text) && Number.isFinite(Date.parse(text))) return text;
  return "";
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
  const volumeDivisor = String(security?.assetType || "stock") === "convertibleBond" ? 10 : 100;
  const rawVolume = finiteOrNull(firstValue(t, ["latestVolume", "volume"]));
  const rawSuspended = firstValue(t, ["suspended"]);
  const rawStatus = firstValue(t, ["tradeStatus", "marketStatus", "stockStatus", "suspensionFlag"]);
  const suspended = typeof rawSuspended === "boolean" ? rawSuspended : parseThsSuspendedStatus(rawStatus);
  const quoteAt = normalizeThsQuoteAt(firstValue(t, ["quoteAt", "tradeTime", "quoteTime", "time"]));
  const limitUp = finiteOrNull(firstValue(t, ["upperLimit", "limitUp"]));
  const limitDown = finiteOrNull(firstValue(t, ["lowerLimit", "limitDown"]));
  return {
    ...security,
    latest,
    high: finiteOrNull(firstValue(t, ["high"])),
    low: finiteOrNull(firstValue(t, ["low"])),
    open: finiteOrNull(firstValue(t, ["open"])),
    preClose: finiteOrNull(firstValue(t, ["preClose", "preclose"])),
    ...(limitUp !== null ? { limitUp } : {}),
    ...(limitDown !== null ? { limitDown } : {}),
    changePct: finiteOrNull(monitorValues.changePct),
    turnover: finiteOrNull(monitorValues.turnover),
    amount: finiteOrNull(monitorValues.amount),
    volume: rawVolume === null ? null : rawVolume / volumeDivisor,
    volumeUnit: "lots",
    ...(quoteAt ? { quoteAt } : {}),
    ...(rawStatus !== undefined && rawStatus !== null && String(rawStatus).trim() ? { marketStatus: String(rawStatus).trim() } : {}),
    ...(suspended !== null ? { suspended } : {}),
    industry: "",
    source: "ths",
    missingFields: missingMonitorQuoteFields(monitorValues)
  };
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
    { code: "000985", secid: "1.000985", assetType: "index" },
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
    latest: finiteOrNull(quote?.latest),
    preClose: finiteOrNull(quote?.preClose),
    open: finiteOrNull(quote?.open),
    high: finiteOrNull(quote?.high),
    low: finiteOrNull(quote?.low),
    change: finiteOrNull(quote?.change),
    changePct: finiteOrNull(quote?.changePct),
    updatedAt: quote?.quoteAt || quote?.updatedAt || new Date().toISOString(),
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

module.exports = {
  marketEmotionCache,
  getMarketSourceHealth,
  aggregateHistoryRows,
  eastChart,
  eastChartCached,
  firstValue,
  thsQuote,
  resolveStockIndustries,
  emotionFromCounts,
  thsMarketEmotion,
  marketEmotionSnapshot,
  scoreAnnouncement,
  announcementCache,
  stockAnnouncements,
  announcements,
  sourceFromQuote,
  quoteProviderMeta,
  timedQuoteSource,
  quoteFederation,
  getQuoteSnapshot,
  getDataFederation,
  CHART_RANGE_LIMITS,
  CHART_DEFAULT_RANGE,
  chartAdjustment,
  getChart,
  REVIEW_INDEX_SECURITIES,
  getReviewIndexChart,
  timeShareForSecurity,
  chartForSecurity,
  testProvider
};
