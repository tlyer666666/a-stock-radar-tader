"use strict";

/**
 * 实时封单的数据源：封单数字用同花顺，腾讯只补盘口。
 *
 * 2026-11-26 盘中实测（决定了这里的分工）：
 * - 同花顺公开涨停池 limit_up_pool 的封单量 order_volume 每 1~10 秒更新一次（平均约 5 秒），一次请求覆盖整张池，
 *   和同花顺 App 里的封单一致 → 封单额、封单手数、封板状态都以它为准；炸板池 open_limit_pool 标出炸板。
 * - 同花顺免费网关的五档 fiverange / realhead 带 CDN 缓存，实测约 1 分钟才变一次（服务器时间停在同一秒），
 *   不能当实时盘口；quote.php 批量接口不给五档且很快被限流。
 * - 所以个股页的五档盘口和现价用腾讯实时五档（每秒一次），封单手数仍用同花顺涨停池的数字覆盖；
 *   腾讯取不到时才退回同花顺网关五档，并在来源里写明「约延迟 1 分钟」。
 * - 同花顺两个池里都没有的代码（北交所、名单过期）用腾讯五档算封单，来源写明。
 *
 * 返回「带五档的报价」，由 limit-seal-stream.cjs 的 computeSeal 统一判定封板状态。取不到的数保持 null。
 */

const POOL_URL = "https://data.10jqka.com.cn/dataapi/limit_up";
const POOL_FIELDS = "199112,10,9001,330329,330330,330324,330325,133971,1968584,19,3475914,3541450";
const LIMIT_POOL_CACHE_MS = 900;
const OPEN_POOL_CACHE_MS = 5000;
const DETAIL_QUOTE_CACHE_MS = 2500;
const DETAIL_COOLDOWN_MS = 5000;

const num = value => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

function shanghaiDate(ms) {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 10);
}

function shanghaiToday(ms) {
  return shanghaiDate(ms).replace(/-/g, "");
}

/** 同花顺涨停池一行 → 带五档的报价：封单量（股）就是涨停价上的买一量；池里的股票当前处在涨停价。 */
function quoteFromLimitPoolRow(row, { fetchedAt, date }) {
  const latest = num(row?.latest);
  const orderShares = num(row?.order_volume);
  return {
    code: String(row?.code || ""), name: String(row?.name || row?.code || ""),
    latest, changePct: num(row?.change_rate), high: latest, limitUp: latest, limitDown: null,
    floatMarketCap: num(row?.currency_value),
    bids: latest !== null && latest > 0 && orderShares !== null && orderShares > 0 ? [{ price: latest, volumeLots: orderShares / 100 }] : [],
    asks: [],
    ...(orderShares !== null && orderShares > 0 ? {} : { sealUnknown: true }),
    quoteAt: fetchedAt, quoteDate: date,
    source: "同花顺涨停池"
  };
}

/** 同花顺炸板池一行：今天封过涨停、现在已打开。 */
function quoteFromOpenPoolRow(row, { fetchedAt, date }) {
  return {
    code: String(row?.code || ""), name: String(row?.name || row?.code || ""),
    latest: num(row?.latest), changePct: num(row?.change_rate), high: null, limitUp: null, limitDown: null,
    floatMarketCap: num(row?.currency_value), bids: [], asks: [], brokenHint: true,
    quoteAt: fetchedAt, quoteDate: date,
    source: "同花顺炸板池"
  };
}

function displayDate(compact) {
  const text = String(compact || "");
  return /^\d{8}$/.test(text) ? `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}` : "";
}

function createThsSealSource({ fetchJson, thsQuote, thsFiveRange, tencentBatch = null, now = () => Date.now(), log = () => {} } = {}) {
  if (typeof fetchJson !== "function" || typeof thsQuote !== "function" || typeof thsFiveRange !== "function") {
    throw new TypeError("fetchJson, thsQuote and thsFiveRange are required");
  }
  const poolCaches = new Map();   // path → { value, expiresAt }
  const poolPending = new Map();  // path → Promise
  const quoteCache = new Map();   // code → { value, expiresAt }
  const cooldown = new Map();     // code → 同花顺个股请求暂停到的时间

  async function fetchPool(path, signal) {
    const rows = [];
    let page = 1;
    let total = 0;
    let date = "";
    do {
      const url = `${POOL_URL}/${path}?page=${page}&limit=200&field=${POOL_FIELDS}&filter=HS,GEM2STAR&order_field=330329&order_type=0&date=${shanghaiToday(now())}`;
      const json = await fetchJson(url, { signal, headers: { Referer: "https://data.10jqka.com.cn/limit_up/continuousUp/" } }, 6000);
      if (Number(json?.status_code) !== 0 || !json?.data) throw new Error(`同花顺${path === "limit_up_pool" ? "涨停" : "炸板"}池返回异常`);
      date = String(json.data.date || date);
      const items = Array.isArray(json.data.info) ? json.data.info : [];
      if (!items.length) break;
      total = Number(json.data.page?.total || items.length || 0);
      rows.push(...items);
      page += 1;
    } while (rows.length < total && page <= 5);
    return { rows, date: displayDate(date) };
  }

  function cachedPool(path, ttl, signal) {
    const hit = poolCaches.get(path);
    if (hit && hit.expiresAt > now()) return Promise.resolve(hit.value);
    if (poolPending.has(path)) return poolPending.get(path);
    const pending = fetchPool(path, signal).then(value => {
      poolCaches.set(path, { value: { ...value, fetchedAt: new Date(now()).toISOString() }, expiresAt: now() + ttl });
      return poolCaches.get(path).value;
    }).finally(() => poolPending.delete(path));
    poolPending.set(path, pending);
    return pending;
  }

  /** 两个池合成一张表：代码 → 报价。涨停池失败时整张表视为不可用（交给腾讯兜底），炸板池失败只少一类状态。 */
  async function pools(signal) {
    const [limit, open] = await Promise.allSettled([cachedPool("limit_up_pool", LIMIT_POOL_CACHE_MS, signal), cachedPool("open_limit_pool", OPEN_POOL_CACHE_MS, signal)]);
    const map = new Map();
    if (open.status === "fulfilled") for (const row of open.value.rows) map.set(String(row?.code || ""), quoteFromOpenPoolRow(row, { fetchedAt: open.value.fetchedAt, date: open.value.date }));
    if (limit.status === "fulfilled") for (const row of limit.value.rows) map.set(String(row?.code || ""), quoteFromLimitPoolRow(row, { fetchedAt: limit.value.fetchedAt, date: limit.value.date }));
    else log(`ths-seal limit pool ${limit.reason?.message || limit.reason}`);
    return { map, ok: limit.status === "fulfilled" };
  }

  /** 腾讯取不到盘口时的最后一档：同花顺免费网关（实测约延迟 1 分钟）。失败后 5 秒内不再请求这只。 */
  async function thsGatewayQuote(code, signal) {
    const security = { code, assetType: "stock" };
    if ((cooldown.get(code) || 0) > now()) throw new Error("同花顺个股请求冷却中");
    const cachedQuote = quoteCache.get(code);
    const quotePromise = cachedQuote && cachedQuote.expiresAt > now()
      ? Promise.resolve(cachedQuote.value)
      : thsQuote(security, { signal }).then(value => { quoteCache.set(code, { value, expiresAt: now() + DETAIL_QUOTE_CACHE_MS }); return value; });
    let quote;
    let book;
    try { [quote, book] = await Promise.all([quotePromise, thsFiveRange(security, { signal })]); }
    catch (error) {
      const t = now();
      cooldown.set(code, t + DETAIL_COOLDOWN_MS);
      if (cooldown.size > 200) {
        for (const [key, until] of cooldown) {
          if (until <= t || cooldown.size > 200) cooldown.delete(key);
          if (cooldown.size <= 200) break;
        }
      }
      throw error;
    }
    while (quoteCache.size > 50) quoteCache.delete(quoteCache.keys().next().value);
    const quoteAt = String(quote?.quoteAt || new Date(now()).toISOString());
    const parsedAt = Date.parse(quoteAt);
    return {
      code, name: String(quote?.name || code),
      latest: num(quote?.latest), changePct: num(quote?.changePct), high: num(quote?.high),
      limitUp: num(quote?.limitUp), limitDown: num(quote?.limitDown), floatMarketCap: num(quote?.floatMarketCap),
      bids: Array.isArray(book?.bids) ? book.bids : [], asks: Array.isArray(book?.asks) ? book.asks : [],
      quoteAt,
      quoteDate: shanghaiDate(Number.isFinite(parsedAt) ? parsedAt : now()),
      source: "同花顺网关（约延迟 1 分钟）"
    };
  }

  async function tencentQuotes(codes, signal) {
    if (!codes.length || typeof tencentBatch !== "function") return new Map();
    try {
      const result = await tencentBatch(codes.map(code => ({ code })), { signal });
      return result?.quotes instanceof Map ? result.quotes : new Map(Object.entries(result?.quotes || {}));
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      log(`ths-seal tencent ${error?.message || error}`);
      return new Map();
    }
  }

  /**
   * @param {{ codes: string[], detailCodes?: string[] }} input
   * @returns {Promise<{ quotes: Map<string, object> }>}
   */
  async function read({ codes = [], detailCodes = [] } = {}, { signal } = {}) {
    const quotes = new Map();
    const detail = new Set(detailCodes);
    const poolCodes = codes.filter(code => !detail.has(code));
    let table = null;
    let tencent = null;
    const loadPools = async () => { try { table = await pools(signal); } catch (error) { if (signal?.aborted) throw signal.reason ?? error; log(`ths-seal pools ${error?.message || error}`); } };
    if (poolCodes.length) await loadPools();
    else {
      // 只有个股页在看：同花顺涨停池/炸板池只包含涨停和炸板股（不含跌停股），
      // 先用腾讯五档判断这只股票今天有没有摸过涨停价，没摸过（含普通股、跌停股与缺价）就不必拉全市场涨停池。
      tencent = await tencentQuotes([...detail], signal);
      const touched = quote => {
        if (!quote) return false;
        const up = quote.limitUp;
        if (!Number.isFinite(up) || up <= 0) return false;
        const highTouched = Number.isFinite(quote.high) && quote.high > 0 && quote.high >= up - 0.0005;
        const latestTouched = Number.isFinite(quote.latest) && quote.latest > 0 && quote.latest >= up - 0.0005;
        return highTouched || latestTouched;
      };
      if ([...detail].some(code => !tencent.has(code) || touched(tencent.get(code)))) await loadPools();
    }
    const thsMap = table?.map || new Map();
    if (!tencent) tencent = await tencentQuotes([...new Set([...detail, ...poolCodes.filter(code => !thsMap.has(code))])], signal);

    for (const code of poolCodes) {
      const ths = thsMap.get(code);
      if (ths) quotes.set(code, ths);
      else if (tencent.has(code)) quotes.set(code, { ...tencent.get(code), source: "腾讯（同花顺涨停池里没有）" });
    }

    for (const code of detail) {
      const ths = thsMap.get(code);
      const live = tencent.get(code);
      if (live) {
        // 盘前/休市时同花顺涨停池与炸板池可能返回上一个交易日的数据；
        // 只有与腾讯实时五档同交易日（或任一方未给日期）时才合并同花顺封单或炸板提示，避免串日污染。
        const thsSameDay = Boolean(ths && (!live.quoteDate || !ths.quoteDate || ths.quoteDate === live.quoteDate));
        const thsLots = thsSameDay && !ths.brokenHint ? ths.bids[0]?.volumeLots ?? null : null;
        const source = !thsSameDay
          ? "腾讯实时五档（不在同花顺涨停池）"
          : ths.brokenHint
            ? "同花顺炸板池 + 腾讯实时五档"
            : "同花顺涨停池（封单）+ 腾讯实时五档";
        quotes.set(code, {
          ...live,
          ...(thsSameDay && ths.brokenHint ? { brokenHint: true } : {}),
          ...(thsLots !== null ? { thsSealLots: thsLots } : {}),
          source
        });
        continue;
      }
      try { quotes.set(code, await thsGatewayQuote(code, signal)); }
      catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (!/冷却中/.test(String(error?.message))) log(`ths-seal gateway ${code} ${error?.message || error}`);
        if (ths) quotes.set(code, ths);
      }
    }
    return { quotes };
  }

  return { read };
}

module.exports = { createThsSealSource, quoteFromLimitPoolRow, quoteFromOpenPoolRow };
