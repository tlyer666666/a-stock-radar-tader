"use strict";
// 从 electron/services.cjs 提取（2026-11-15 审核 P0-2b 拆分）。
// services.cjs 通过顶部解构回本模块并继续按原契约 re-export，勿在这里引入
// 对 services.cjs 的反向依赖。
// 同花顺免费网关的个股报价与日K线（不需要 QuantAPI Token），以及三路行情的健康度/熔断。
const thsFreeMarket = require("../ths-free-market.cjs");
const { decorateLimitPoolItem } = require("../strategy-intelligence.cjs");
const { BoundedCache } = require("../bounded-cache.cjs");
const _runtime = require("./runtime.cjs");
const { serviceRuntime, historyCache, fuyao, topicPoolCache, ladderPoolsCaches } = _runtime;
function trackServiceRequest(...args) { return _runtime.trackServiceRequest(...args); }
function serviceSignal(...args) { return _runtime.serviceSignal(...args); }
function isAStockCode(...args) { return _runtime.isAStockCode(...args); }
function fetchJson(...args) { return _runtime.fetchJson(...args); }
const _backtest = require("./backtest.cjs");
function eastHistoryCached(...args) { return _backtest.eastHistoryCached(...args); }
function displayDate(...args) { return _backtest.displayDate(...args); }
function isRiskStockName(...args) { return _backtest.isRiskStockName(...args); }
function todayInShanghai(...args) { return _backtest.todayInShanghai(...args); }
const _strategy_scan = require("./strategy-scan.cjs");
function industryFromIndex(...args) { return _strategy_scan.industryFromIndex(...args); }
const _fuyao_review = require("./fuyao-review.cjs");
function fuyaoDataMayChange(...args) { return _fuyao_review.fuyaoDataMayChange(...args); }

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

async function recentTradingDates(count = 10) {
  let benchmark;
  try {
    // 交易日历：同花顺全A为主；取不到时用东方财富沪深300应急。
    benchmark = await thsAllAHistory(Math.max(12, count + 8));
  } catch (error) {
    serviceSignal()?.throwIfAborted();
    benchmark = await eastHistoryCached(
      { code: "000300", secid: "1.000300", assetType: "index" },
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
  const pool = rows
    .map((item) => normalizeThsLimitUpItem(item, date, endpoint.provider))
    .filter((item) => item && isAStockCode(item.code) && !isRiskStockName(item.name));
  if (type === "failed" && pool.length) await fillFailedOpenCounts(pool, date);
  return {
    date,
    serverTradingDate: rows.length ? date : "",
    // 空池没有自带的交易日证据：与东方财富空炸板池同口径，交给交易日历确认。
    ...(type === "failed" && !rows.length ? { dateConfirmed: false, dataAbsent: true } : {}),
    fetchedAt: new Date().toISOString(),
    total,
    provider: endpoint.provider,
    pool
  };
}

// 同花顺公开炸板池不给开板次数（open_board_count 恒为 null），页面整列都是「--」。
// 配了扶摇 Key 时用扶摇炸板池的 open_times 按代码补上；扶摇按次计费，盘中 60 秒、其余 20 分钟才查一次。
const fuyaoOpenCountCache = new BoundedCache({ maxEntries: 8, maxBytes: 512 * 1024, staleTtlMs: 0, now: () => Date.now() });

async function fillFailedOpenCounts(pool, date) {
  if (!fuyao.configured() || !pool.some((item) => item.openBoardCount === null)) return;
  try {
    const live = date === displayDate(todayInShanghai()) && fuyaoDataMayChange();
    const counts = await serviceRuntime.cached(fuyaoOpenCountCache, `${date}:${live ? "live" : "closed"}`, () => (live ? 60 * 1000 : 20 * 60 * 1000), async () => {
      const result = await serviceRuntime.track(() => trackServiceRequest(fuyao.limitBreakPool({ date, signal: serviceSignal() })));
      return Object.fromEntries(result.rows.filter((row) => Number.isInteger(row.openTimes) && row.openTimes > 0).map((row) => [row.code, row.openTimes]));
    });
    for (const item of pool) {
      if (item.openBoardCount !== null || !counts[item.code]) continue;
      item.openBoardCount = counts[item.code];
      item.openBoardCountProvider = "fuyao_limit_break_pool";
      if (item.raw && typeof item.raw === "object") item.raw = { ...item.raw, zbc: counts[item.code] };
    }
  } catch { /* 扶摇不可用时开板次数仍为未知 */ }
}

// 同花顺为主源；只有调用方显式要东方财富（交叉核验/日期确认）时才直接走东方财富。
function preferredTopicPoolProvider(options) {
  return options?.provider === "eastmoney" ? "eastmoney" : "ths";
}

async function topicPoolForDate(date, type = "limit", options = {}) {
  const compactDate = String(date || "").replaceAll("-", "");
  const preferredProvider = preferredTopicPoolProvider(options);
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
    preferredTopicPoolProvider(options),
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

function conceptRootName(input) {
  const raw = String(input?.name || input || "").trim();
  return raw
    .replace(/[ⅠⅡⅢⅣⅤ]+$/u, "")
    .replace(/(?:同花顺)?(?:概念|行业|指数|板块)$/u, "")
    .trim() || raw;
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

module.exports = {
  thsIndexHistory,
  thsAllAHistory,
  recentTradingDates,
  selectLimitUpTradingDates,
  poolTimeRawFromEpoch,
  thsLimitUpConsecutiveBoards,
  normalizeThsLimitUpItem,
  mergeThsAndEastmoneyLimitPool,
  THS_POOL_ENDPOINT,
  thsTopicPoolForDate,
  fuyaoOpenCountCache,
  fillFailedOpenCounts,
  preferredTopicPoolProvider,
  topicPoolForDate,
  recentLimitUpPools,
  currentLadderPools,
  conceptRootName,
  discoverLimitUps,
  discoverRecentLimitUpSnapshot,
  discoverRecentLimitUps
};
