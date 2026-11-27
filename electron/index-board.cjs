"use strict";

/**
 * 驾驶舱指数条（对照同花顺手机版首页的指数区）：上证、深证、创业板、科创50、北证50、沪深300、上证50、
 * 中证500、中证1000、中证2000 的实时点位、涨跌、成交额、涨跌家数和当日分时。
 *
 * - 行情：东方财富 ulist 一次批量取（1 秒缓存，实时跳动走 index-stream.cjs 推送）；上证指数、深证成指的成交额与涨跌家数就是沪市、深市全市场口径，
 *   两者相加 = 沪深两市成交额（不含北交所）。
 * - 分时：东方财富 trends2 逐个取，60 秒缓存，压到最多 121 个点，只给迷你走势图用。分时失败不影响行情。
 * 所有请求走调用方注入的 fetchJson（复用 http-client 的超时、字节上限和熔断）。取不到的数字保持 null。
 */

const ULIST_URL = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const TRENDS_URL = "https://push2his.eastmoney.com/api/qt/stock/trends2/get";
const QUOTE_CACHE_MS = 1_000;
const TREND_CACHE_MS = 60_000;
const MAX_TREND_POINTS = 121;

const INDEX_BOARD = Object.freeze([
  { secid: "1.000001", code: "000001", name: "上证指数", major: true },
  { secid: "0.399001", code: "399001", name: "深证成指", major: true },
  { secid: "0.399006", code: "399006", name: "创业板指", major: true },
  { secid: "1.000688", code: "000688", name: "科创50", major: true },
  { secid: "0.899050", code: "899050", name: "北证50", major: false },
  { secid: "1.000300", code: "000300", name: "沪深300", major: false },
  { secid: "1.000016", code: "000016", name: "上证50", major: false },
  { secid: "1.000905", code: "000905", name: "中证500", major: false },
  { secid: "1.000852", code: "000852", name: "中证1000", major: false },
  { secid: "2.932000", code: "932000", name: "中证2000", major: false }
]);

const num = value => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() && value !== "-" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const count = value => { const n = num(value); return n !== null && n >= 0 ? Math.round(n) : null; };

/** 接口时间戳（秒）→ 北京时间 { date: "YYYY-MM-DD", time: "HH:mm" }。 */
function shanghaiParts(seconds) {
  const s = num(seconds);
  if (s === null || s <= 0) return { date: "", time: "" };
  const iso = new Date(s * 1000 + 8 * 3600_000).toISOString();
  return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
}

function normalizeIndexQuote(raw, meta) {
  const rawLatest = num(raw?.f2);
  const latest = rawLatest !== null && rawLatest > 0 ? rawLatest : null;
  const stamp = shanghaiParts(raw?.f124);
  return {
    code: meta.code, secid: meta.secid, name: meta.name, major: meta.major,
    latest, change: num(raw?.f4), changePct: num(raw?.f3),
    open: num(raw?.f17), high: num(raw?.f15), low: num(raw?.f16), preClose: num(raw?.f18),
    amount: num(raw?.f6), up: count(raw?.f104), down: count(raw?.f105), flat: count(raw?.f106),
    date: stamp.date, time: stamp.time
  };
}

/**
 * 分时（每分钟一个点，全天 241 个）→ 每 2 分钟取一个，全天最多 121 个；按固定步长抽样，
 * 这样盘中半天的走势只占图宽的一半（和同花顺一样），最后一个点总是保留。
 */
function downsample(values, step = 2) {
  if (values.length <= 2) return values.slice();
  const out = values.filter((_, index) => index % step === 0);
  if ((values.length - 1) % step !== 0) out.push(values.at(-1));
  return out.slice(0, MAX_TREND_POINTS);
}

function parseTrends(json) {
  const rows = Array.isArray(json?.data?.trends) ? json.data.trends : [];
  const prices = [];
  let date = "";
  for (const row of rows) {
    const [stamp, price] = String(row).split(",");
    const value = num(price);
    if (value === null || value <= 0) continue;
    prices.push(value);
    date = String(stamp || "").slice(0, 10) || date;
  }
  return { date, points: downsample(prices), preClose: num(json?.data?.preClose) };
}

/** 沪深两市合计：上证指数 + 深证成指的全市场成交额与涨跌家数。任何一边缺就不合计，避免只算半个市场。 */
function marketTotals(indices) {
  const sh = indices.find(item => item.code === "000001");
  const sz = indices.find(item => item.code === "399001");
  if (!sh || !sz) return null;
  const both = (key) => sh[key] !== null && sz[key] !== null ? sh[key] + sz[key] : null;
  const amount = both("amount");
  const up = both("up");
  const down = both("down");
  if (amount === null && up === null) return null;
  return { amount, up, down, flat: both("flat"), scope: "沪深两市（不含北交所）" };
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function createIndexBoard({ fetchJson, now = () => Date.now() } = {}) {
  if (typeof fetchJson !== "function") throw new TypeError("fetchJson is required");
  let quoteCache = null;
  let quotePending = null;
  const trendCache = new Map();

  async function fetchQuotes(signal) {
    const fields = "f2,f3,f4,f6,f12,f13,f14,f15,f16,f17,f18,f104,f105,f106,f124";
    const url = `${ULIST_URL}?fltt=2&invt=2&fields=${fields}&secids=${INDEX_BOARD.map(item => item.secid).join(",")}`;
    const json = await fetchJson(url, { signal, headers: { Referer: "https://quote.eastmoney.com/" } }, 8000);
    const rows = Array.isArray(json?.data?.diff) ? json.data.diff : [];
    const bySecid = new Map(rows.map(row => [`${row?.f13}.${row?.f12}`, row]));
    return INDEX_BOARD.map(meta => normalizeIndexQuote(bySecid.get(meta.secid) || {}, meta));
  }

  async function quotes(forceRefresh, signal) {
    signal?.throwIfAborted?.();
    if (!forceRefresh && quoteCache && quoteCache.expiresAt > now()) return quoteCache.value;
    if (!quotePending) {
      // 共用的这一次请求不带任何调用方的取消信号：否则第一个调用方取消，会连累后面搭车的调用方。
      quotePending = fetchQuotes(undefined).then(value => {
        if (value.some(item => item.latest !== null)) quoteCache = { value, expiresAt: now() + QUOTE_CACHE_MS };
        return value;
      }).finally(() => { quotePending = null; });
    }
    return waitWithSignal(quotePending, signal);
  }

  async function trendOf(meta, forceRefresh, signal) {
    signal?.throwIfAborted?.();
    const hit = trendCache.get(meta.secid);
    if (!forceRefresh && hit?.value && hit.expiresAt > now()) return hit.value;
    let pending = hit?.pending;
    if (!pending) {
      const url = `${TRENDS_URL}?secid=${meta.secid}&fields1=f1,f2,f8&fields2=f51,f53&iscr=0&ndays=1`;
      // 分时请求同样不绑定单个调用方的取消信号，避免首个调用方取消导致并发调用方分时退化为 null。
      pending = fetchJson(url, { headers: { Referer: "https://quote.eastmoney.com/" } }, 8000)
        .then(parseTrends)
        .then(value => { trendCache.set(meta.secid, { value, expiresAt: now() + TREND_CACHE_MS }); return value; })
        .catch(() => {
          const current = trendCache.get(meta.secid);
          if (current?.pending === pending) {
            if (hit?.value) trendCache.set(meta.secid, { value: hit.value, expiresAt: hit.expiresAt });
            else trendCache.delete(meta.secid);
          }
          return hit?.value || null;
        });
      trendCache.set(meta.secid, { ...hit, pending });
    }
    return waitWithSignal(pending, signal);
  }

  /**
   * @param {{ forceRefresh?: boolean, withTrends?: boolean, signal?: AbortSignal }} [options]
   */
  async function load({ forceRefresh = false, withTrends = true, signal } = {}) {
    signal?.throwIfAborted?.();
    const [indices, trends] = await Promise.all([
      quotes(forceRefresh, signal),
      withTrends ? Promise.all(INDEX_BOARD.map(meta => trendOf(meta, forceRefresh, signal))) : Promise.resolve([])
    ]);
    signal?.throwIfAborted?.();
    if (!indices.some(item => item.latest !== null)) throw new Error("指数行情暂时没取到，请稍后重试");
    const merged = indices.map((item, index) => {
      const trend = trends[index];
      // 只用和行情同一交易日的分时，避免开盘前把昨天的走势画成今天的。
      const points = trend && trend.points.length && (!item.date || !trend.date || trend.date === item.date) ? trend.points : [];
      return { ...item, trend: points };
    });
    const tradingDate = merged.map(item => item.date).filter(Boolean).sort().at(-1) || "";
    const missing = merged.filter(item => item.latest === null).map(item => item.name);
    return {
      fetchedAt: new Date(now()).toISOString(),
      tradingDate,
      indices: merged,
      totals: marketTotals(merged),
      ...(missing.length ? { missing } : {}),
      source: "东方财富指数行情"
    };
  }

  /**
   * 给实时推送用的高频快照：不走缓存，直接返回「东方财富 stock 字段格式」（f43 最新价、f86 时间戳…），
   * 方便和 SSE 推送合并。交易所指数快照约每 3 秒一次，1 秒轮询一次能在快照出来后 1 秒内拿到。
   */
  async function pollRaw({ signal } = {}) {
    const fields = "f2,f3,f4,f6,f12,f13,f15,f16,f17,f18,f104,f105,f106,f124";
    const url = `${ULIST_URL}?fltt=2&invt=2&fields=${fields}&secids=${INDEX_BOARD.map(item => item.secid).join(",")}`;
    const json = await fetchJson(url, { signal, headers: { Referer: "https://quote.eastmoney.com/" } }, 3000);
    const rows = Array.isArray(json?.data?.diff) ? json.data.diff : [];
    return rows.map(row => ({ secid: `${row?.f13}.${row?.f12}`, data: ulistToStockFields(row) }))
      .filter(item => INDEX_BOARD.some(meta => meta.secid === item.secid));
  }

  return { load, pollRaw };
}

/** ulist 字段 → stock/sse 字段（两者含义相同、编号不同）。缺的字段不放进去，避免把已知值合并成空。 */
function ulistToStockFields(row) {
  const map = { f2: "f43", f3: "f170", f4: "f169", f15: "f44", f16: "f45", f17: "f46", f18: "f60", f6: "f48", f104: "f113", f105: "f114", f106: "f115", f124: "f86" };
  const out = {};
  for (const [from, to] of Object.entries(map)) {
    const value = num(row?.[from]);
    if (value !== null && (from !== "f2" || value > 0)) out[to] = value;
  }
  return out;
}

module.exports = { createIndexBoard, ulistToStockFields, normalizeIndexQuote, parseTrends, marketTotals, downsample, INDEX_BOARD };
