"use strict";

const { fetchJsonWithPolicy } = require("./http-client.cjs");
const { validateDailyBarRows } = require("./daily-bar-validation.cjs");

// This scanner needs amount and a confirmed adjustment basis. Do not silently
// substitute feeds whose daily bars omit those fields or change that basis.
// 同花顺免费日线是主源；东方财富/搜狐+腾讯只在同花顺取不到时应急。
// 注入了自定义 fetchJson（测试或代理）而没给 thsHistory 时不走同花顺，避免测试打真实网络。
const THS_FAULT_LIMIT = 3;
const THS_PAUSE_MS = 60000;
const HISTORY_RETRY_MS = 5 * 60 * 1000;
function defaultThs() {
  const ths = require("./ths-free-market.cjs");
  return { history: ths.thsFreeDailyHistory, quote: ths.thsFreeQuote };
}
function isThsProviderFault(error) {
  // 数据不完整/字段缺失只影响这一只证券，不代表同花顺整体不可用。
  return !/^THS_FREE_(?:INCOMPLETE_HISTORY|EMPTY_HISTORY|MISMATCH|NO_PRICE|UNSUPPORTED)$/.test(String(error?.code || "")) && error?.code !== "TREND_DATA_UNAVAILABLE";
}

function createTrendMarketData({ sinaPageRetryDelays = [1500, 4000, 8000], fetchJson = fetchJsonWithPolicy, now = () => new Date(), historyBars = 320, ths = fetchJson === fetchJsonWithPolicy ? defaultThs() : null, clock = () => Date.now(),
  // 本地日线库（daily-bar-store）与“最近完整交易日”：都提供时，不复权日线先查本机，缺了才下载。
  dailyStore = null, asOf = null } = {}) {
  if (!Number.isInteger(historyBars) || historyBars < 20 || historyBars > 1500) throw new Error("historyBars必须为20至1500的整数");
  const contexts = new WeakMap();
  const newContext = () => ({ failedHosts: new Map(), sources: new Map(), raw: new Map(), universe: null, quotes: new Map(), ths: { faults: 0, pausedUntil: 0 } });
  const defaultContext = newContext();
  const context = signal => {
    if (!signal) return defaultContext;
    if (!contexts.has(signal)) contexts.set(signal, newContext());
    return contexts.get(signal);
  };
  const unavailable = message => Object.assign(new Error(message), { code: "TREND_DATA_UNAVAILABLE" });
  const localCapacityError = error => ["QUEUE_FULL", "QUEUE_TIMEOUT"].includes(error?.code);
  const SINA_PAGE_RETRY_DELAYS = sinaPageRetryDelays;
  const sleep = (ms, signal) => new Promise((resolve, reject) => {
    if (!ms) return resolve();
    const timer = setTimeout(() => { signal?.removeEventListener?.("abort", stop); resolve(); }, ms);
    const stop = () => { clearTimeout(timer); reject(signal.reason); };
    signal?.addEventListener?.("abort", stop, { once: true });
  });
  function record(ctx, stage, source, ok, result, error) {
    const key = `${stage}:${source}`;
    const previous = ctx.sources.get(key) || { stage, source, status: "ok", successes: 0, failures: 0,
      latestDate: null, detail: "", crossCheckedRows: 0 };
    const rows = Array.isArray(result) ? result : result?.rows;
    const crossCheck = result?.provenance?.crossCheck;
    ctx.sources.set(key, { ...previous, status: ok ? "ok" : "error",
      successes: previous.successes + Number(ok), failures: previous.failures + Number(!ok),
      latestDate: rows?.at(-1)?.date || previous.latestDate,
      detail: ok ? source === "ths-free" ? "同花顺免费日线（按年文件，当日用实时快照补齐）" : source === "ths-fuyao" ? "同花顺扶摇日线（以历史接口交易日期为准）" : crossCheck ?`OHLC原价逐日交叉核验${crossCheck.matchedRows}根；量额来自搜狐（手/万元→元），未跨源核验量额` : source === "tencent-csi-000985" ? "中证全指价格日线；未提供成交额，保持缺失" : source === "fuyao-csi-000985" ? "同花顺扶摇中证全指日线" : "数据已返回并通过来源契约核对" : String(error?.message || "数据源失败"),
      crossCheckedRows: previous.crossCheckedRows + (crossCheck?.matchedRows || 0) });
  }
  async function tracked(ctx, stage, source, signal, operation) {
    try {
      signal?.throwIfAborted();
      const result = await operation();
      signal?.throwIfAborted();
      record(ctx, stage, source, true, result);
      return result;
    } catch (error) {
      if (!signal?.aborted && !localCapacityError(error)) record(ctx, stage, source, false, null, error);
      throw error;
    }
  }
  async function withFallback(ctx, stage, host, signal, primary, fallback) {
    const failure = ctx.failedHosts.get(host), age = failure ? clock() - failure.at : Infinity;
    let primaryError = age >= 0 && age < HISTORY_RETRY_MS ? failure.error : null;
    if (!primaryError) ctx.failedHosts.delete(host);
    if (!primaryError) {
      try { return await tracked(ctx, stage, "eastmoney", signal, primary); }
      catch (error) {
        if (signal?.aborted || error.code !== "MARKET_DATA_SOURCE_UNAVAILABLE" || error.providerRc !== undefined || [401, 403, 429].includes(error.status)) throw error;
        primaryError = error;
        ctx.failedHosts.set(host, { error, at: clock() });
      }
    }
    try { return await fallback(); }
    catch (error) {
      if (signal?.aborted || localCapacityError(error) || error.code === "TREND_DATA_UNAVAILABLE") throw error;
      // A transient HTTP failure in one fallback request is not evidence that
      // every security is unavailable. Keep its HTTP status and let the scan
      // continue; a cancelled request still exits above without publication.
      if (Number.isInteger(error?.status)) throw Object.assign(new Error(`备用源请求失败：${error.message}；主源亦未可用`, { cause: error }), {
        code: "TREND_SOURCE_REQUEST_FAILED", status: error.status, stage
      });
      throw primaryError;
    }
  }
  async function request(url, stage, label, signal) {
    try {
      signal?.throwIfAborted();
      const json = await fetchJson(url, { ...(signal ? { signal } : {}) }, {
        timeoutMs: 15000,
        retries: 1,
        minimumGapMs: 100,
        headers: { Referer: "https://quote.eastmoney.com/", "User-Agent": "Mozilla/5.0" }
      });
      if (json?.rc !== undefined && Number(json.rc) !== 0) {
        throw Object.assign(new Error(`数据源返回 rc=${String(json.rc)}${json.msg ? `：${String(json.msg).slice(0, 160)}` : ""}`), { providerRc: json.rc });
      }
      return json;
    } catch (cause) {
      if (signal?.aborted) throw signal.reason ?? cause;
      // Admission pressure is local and says nothing about provider health.
      // Preserve it so fallback cannot amplify an already overloaded queue.
      if (localCapacityError(cause)) throw cause;
      const endpoint = new URL(url);
      const reason = cause instanceof Error ? cause.message : String(cause);
      const networkCode = cause?.cause?.code || cause?.code;
      const status = Number(cause?.status) || undefined;
      const remedy = status === 401 || status === 403
        ? "数据源拒绝访问，请核对数据源授权与服务状态后重试"
        : status === 429
          ? "数据源限制请求频率，请稍后重试"
          : "请检查网络或代理是否能访问该域名，并在数据源恢复后重试";
      const error = new Error(
        `东方财富${label}请求失败（${endpoint.hostname}）：${reason}${networkCode ? ` [${networkCode}]` : ""}。${remedy}。`,
        { cause }
      );
      Object.assign(error, {
        code: "MARKET_DATA_SOURCE_UNAVAILABLE", source: "eastmoney", stage,
        endpoint: `${endpoint.origin}${endpoint.pathname}`,
        ...(cause?.providerRc !== undefined ? { providerRc: cause.providerRc } : {}),
        ...(status ? { status } : {})
      });
      throw error;
    }
  }
  const number = (value) => {
    if (value === null || value === undefined || String(value).trim() === "" || value === "-") return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  async function publicJson(url, signal, referer) {
    signal?.throwIfAborted();
    const host = new URL(url).hostname, sohu = host === "q.stock.sohu.com", sina = host === "vip.stock.finance.sina.com.cn";
    return fetchJson(url, { ...(signal ? { signal } : {}) }, { timeoutMs: 12000, retries: sohu ? 2 : 1, minimumGapMs: sohu ? 1000 : sina ? 350 : 180,
      headers: { Referer: referer, "User-Agent": "Mozilla/5.0" } });
  }
  const boardFilter = code => /^(000|001|002|003)\d{3}$/.test(code) ? "m:0+t:6"
    : /^(600|601|603|605)\d{3}$/.test(code) ? "m:1+t:2"
      : /^(300|301|302)\d{3}$/.test(code) ? "m:0+t:80"
        : /^(688|689)\d{3}$/.test(code) ? "m:1+t:23"
          : /^(?:[48]\d{5}|920\d{3})$/.test(code) ? "m:0+t:81+s:2048" : null;
  async function sinaUniverse(ctx, signal) {
    if (!ctx.universe) ctx.universe = tracked(ctx, "universe", "sina-all-a", signal, async () => {
      const base = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.";
      const getCount = async () => {
        const value = await publicJson(`${base}getHQNodeStockCount?node=hs_a`, signal, "https://finance.sina.com.cn/");
        const count = typeof value === "string" || typeof value === "number" ? number(value) : null;
        if (!Number.isInteger(count) || count < 1 || count > 20000) throw unavailable("新浪全A名单总数无效，无法确认完整覆盖");
        return count;
      };
      const total = await getCount(), rows = [], seen = new Set();
      // 新浪连续翻页会被限流，返回空页或短页：同一页退避重试，而不是直接判定缺页。
      const pageData = async (page, expected) => {
        let data = null;
        for (let attempt = 0; attempt < SINA_PAGE_RETRY_DELAYS.length + 1; attempt++) {
          if (attempt) await sleep(SINA_PAGE_RETRY_DELAYS[attempt - 1], signal);
          data = await publicJson(`${base}getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page`, signal, "https://finance.sina.com.cn/").catch(error => {
            if (signal?.aborted || localCapacityError(error)) throw error;
            return null;
          });
          if (Array.isArray(data) && data.length === expected) return data;
        }
        return data;
      };
      for (let page = 1; rows.length < total; page++) {
        const data = await pageData(page, Math.min(100, total - rows.length));
        if (!Array.isArray(data) || data.length !== Math.min(100, total - rows.length)) throw unavailable(`新浪全A名单缺页：${rows.length}/${total}`);
        for (const item of data) {
          const code = String(item.code || ""), filter = boardFilter(code), name = String(item.name || "").trim();
          const prefix = /^(600|601|603|605|688|689)/.test(code) ? "sh" : filter === "m:0+t:81+s:2048" ? "bj" : "sz";
          if (!filter || !name || item.symbol !== `${prefix}${code}` || seen.has(code)) throw unavailable(`新浪全A名单含重复、身份不一致或未知证券：${code}/${item.symbol || "缺少标识"}（第${page}页），无法确认完整覆盖`);
          seen.add(code);
          rows.push({ code, name, secid: `${prefix === "sh" ? 1 : 0}.${code}`, industry: "未分类", assetType: "stock", filter });
        }
      }
      if (await getCount() !== total) throw unavailable("新浪全A名单在分页期间总数变化，无法确认完整覆盖");
      return rows;
    });
    return ctx.universe;
  }

  /** 名单自带的当日行情（f124 为最后成交时间）：只交给本地日线库判断能否补成收盘日线，不直接参与选股。 */
  function closeSnapshot(item, fetchedAt) {
    const value = key => (typeof item?.[key] === "number" && Number.isFinite(item[key]) ? item[key] : null);
    const [latest, open, high, low, preClose, volume, amount, at] = ["f2", "f17", "f15", "f16", "f18", "f5", "f6", "f124"].map(value);
    if (![latest, open, high, low, preClose, volume, amount, at].every(number => number !== null && number > 0)) return {};
    const turnover = value("f8"); // 换手率（%），名单自带；补进本地日线后选股和自定义条件才有当日换手
    return { closeSnapshot: { latest, open, high, low, preClose, volume, amount, ...(turnover !== null ? { turnover } : {}), quoteAt: new Date(at * 1000).toISOString(), quoteAtIsTradeTime: true, fetchedAt, source: "eastmoney-list" } };
  }

  // 1.6.47：push2delay 的 clist 接口时常整体返回空，先用 push2，再试 push2delay，都不行才退到新浪。
  const EAST_UNIVERSE_ORIGINS = ["https://push2.eastmoney.com", "https://push2delay.eastmoney.com"];
  async function eastUniversePage(options) {
    let lastError;
    for (const origin of EAST_UNIVERSE_ORIGINS) {
      try { return await eastUniversePageAt(origin, options); }
      catch (error) {
        // 拒绝访问、限频或数据源明确返回错误码时不换主机，按原错误上报。
        if (options.signal?.aborted || localCapacityError(error) || error?.providerRc !== undefined || [401, 403, 429].includes(error?.status)) throw error;
        lastError = error;
      }
    }
    throw lastError;
  }
  async function eastUniversePageAt(origin, { filter, page, pageSize, signal }) {
    const url = new URL(`${origin}/api/qt/clist/get`);
    const params = { pn: page, pz: pageSize, po: 0, np: 1, fltt: 2, invt: 2,
      ut: "bd1d9ddb04089700cf9c27f6f7426281", fs: filter, fid: "f12", fields: "f12,f14,f13,f100,f26,f2,f5,f6,f8,f15,f16,f17,f18,f124" };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const fetchedAt = clock();
    const json = await request(url.href, "universe", "证券名单", signal);
    const total = number(json?.data?.total);
    if (!Number.isInteger(total) || total < 0 || !Array.isArray(json?.data?.diff)) {
      // 空响应按数据源不可用处理，换下一个主机或退到备用源。
      throw Object.assign(new Error(`东方财富证券名单返回空数据（${new URL(origin).hostname}）`), { code: "MARKET_DATA_SOURCE_UNAVAILABLE", source: "eastmoney", stage: "universe" });
    }
    return { total, rows: json.data.diff.map(item => ({
      code: String(item.f12 || ""),
      name: String(item.f14 || ""),
      secid: `${Number(item.f13) === 1 ? 1 : 0}.${String(item.f12 || "")}`,
      industry: String(item.f100 || "未分类"),
      assetType: "stock",
      ...closeSnapshot(item, fetchedAt),
      ...(/^\d{8}$/.test(String(item.f26 || "")) && /^\d{4}-\d{2}-\d{2}$/.test(`${String(item.f26).slice(0,4)}-${String(item.f26).slice(4,6)}-${String(item.f26).slice(6,8)}`) ? { listingDate: `${String(item.f26).slice(0,4)}-${String(item.f26).slice(4,6)}-${String(item.f26).slice(6,8)}`, listingDateSource: "eastmoney-f26" } : {})
    })) };
  }

  async function fetchUniversePage(options) {
    const { filter, page, pageSize, signal } = options;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw unavailable("证券名单分页参数无效");
    const ctx = context(signal);
    return withFallback(ctx, "universe", "eastmoney-clist", signal, () => eastUniversePage(options), async () => {
      const all = await sinaUniverse(ctx, signal), selected = all.filter(row => row.filter === filter);
      if (!["m:0+t:6", "m:1+t:2", "m:0+t:80", "m:1+t:23", "m:0+t:81+s:2048"].includes(filter)) throw unavailable("证券名单板块参数无效");
      return { total: selected.length, rows: selected.slice((page - 1) * pageSize, page * pageSize).map(({ filter: _ignored, ...row }) => row), source: "sina-all-a" };
    });
  }

  async function eastHistory(security, adjustment, { signal, priceOnly = false } = {}) {
    if (!/^\d{6}$/.test(security?.code) || !/^[01]\.\d{6}$/.test(security?.secid) ||
        security.secid.slice(2) !== security.code || !["none", "front"].includes(adjustment)) {
      throw new Error("趋势扫描证券标识或复权参数无效");
    }
    const url = new URL("https://push2his.eastmoney.com/api/qt/stock/kline/get");
    const params = { secid: security.secid, klt: 101, fqt: adjustment === "front" ? 1 : 0,
      lmt: historyBars, end: "20500101", fields1: "f1,f2,f3,f4,f5,f6",
      fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61" };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const json = await request(url.href, "history", adjustment === "front" ? "前复权日线" : "不复权日线", signal);
    if (String(json?.data?.code || "") !== security.code) throw new Error("日线返回的证券与请求不一致");
    if (!Array.isArray(json.data.klines) || !json.data.klines.length) throw new Error("日线数据为空");
    const rows = json.data.klines.map(line => {
      const values = String(line).split(",");
      return { date: values[0], open: number(values[1]), close: number(values[2]),
        high: number(values[3]), low: number(values[4]), volume: number(values[5]),
        amount: number(values[6]), amplitude: number(values[7]), changePct: number(values[8]),
        change: number(values[9]), turnover: number(values[10]) };
    });
    return { rows: validateRows(rows, "东方财富", priceOnly), adjustment, source: "eastmoney" };
  }

  function validateRows(rows, label, priceOnly = false) {
    return validateDailyBarRows(rows, { label, priceOnly });
  }
  const symbolFor = security => `${security.secid.startsWith("1.") ? "sh" : /^(?:[48]|920)/.test(security.code) ? "bj" : "sz"}${security.code}`;
  async function tencentRows(security, adjustment, signal) {
    const symbol = symbolFor(security), field = adjustment === "front" ? "qfqday" : "day";
    const url = new URL("https://web.ifzq.gtimg.cn/appstock/app/fqkline/get");
    url.searchParams.set("param", `${symbol},day,,,${historyBars},${adjustment === "front" ? "qfq" : ""}`);
    const json = await publicJson(url.href, signal, "https://gu.qq.com/");
    if (Number(json?.code) !== 0 || !Array.isArray(json?.data?.[symbol]?.[field]) || !json.data[symbol][field].length) {
      throw unavailable(adjustment === "front" ? `腾讯未提供${security.code}明确前复权qfqday，不能用普通day替代` : `腾讯${symbol}日线身份或字段缺失`);
    }
    return validateRows(json.data[symbol][field].map(row => ({ date: String(row[0] || ""), open: number(row[1]), close: number(row[2]),
      high: number(row[3]), low: number(row[4]), volume: number(row[5]), amount: null })), "腾讯", true).slice(-historyBars);
  }
  async function fallbackRaw(security, ctx, signal) {
    return tracked(ctx, "raw", "sohu+tencent-raw", signal, async () => {
      const end = new Date(now()), start = new Date(end.getTime() - Math.max(730, Math.ceil(historyBars * 1.6) + 60) * 86400000);
      const date = value => value.toISOString().slice(0, 10).replaceAll("-", "");
      const url = new URL("https://q.stock.sohu.com/hisHq");
      for (const [key, value] of Object.entries({ code: `cn_${security.code}`, start: date(start), end: date(end), stat: 1, order: "D", period: "d", rt: "json" })) url.searchParams.set(key, String(value));
      const json = await publicJson(url.href, signal, "https://q.stock.sohu.com/");
      const data = Array.isArray(json) ? json.find(item => item.code === `cn_${security.code}`) : null;
      if (data?.status !== 0 || !Array.isArray(data.hq)) throw unavailable(`搜狐${security.code}原始日线身份或字段缺失`);
      // Sohu's own history table labels volume as lots and amount as 10,000 CNY:
      // https://q.stock.sohu.com/cn/300170/lshq.shtml . Never estimate amount=C*V.
      const rows = validateRows(data.hq.map(row => ({ date: String(row[0] || ""), open: number(row[1]), close: number(row[2]),
        change: number(row[3]), changePct: number(String(row[4] || "").replace("%", "")), low: number(row[5]), high: number(row[6]),
        volume: number(row[7]), amount: number(row[8]) === null ? null : number(row[8]) * 10000, turnover: number(String(row[9] || "").replace("%", "")) })), "搜狐").slice(-historyBars);
      const check = new Map((await tencentRows(security, "none", signal)).map(row => [row.date, row]));
      for (const row of rows) {
        const other = check.get(row.date);
        if (!other) throw unavailable(`腾讯原价历史缺少交叉核验日期：${security.code} ${row.date}`);
        // Tencent volume units differ across boards and have no unit metadata
        // here. Do not guess a conversion: cross-check prices only, while the
        // actual volume and amount use Sohu's documented units throughout.
        if (["open", "high", "low", "close"].some(key => Math.abs(row[key] - other[key]) > .005 + 1e-9)) {
          throw unavailable(`搜狐与腾讯原价交叉核验不一致：${security.code} ${row.date}`);
        }
      }
      return { rows, adjustment: "none", source: "sohu+tencent-raw", provenance: { source: "sohu+tencent-raw", amountUnit: "CNY", volumeUnit: "lot",
        amountDocumentation: "https://q.stock.sohu.com/cn/300170/lshq.shtml", crossCheck: { source: "tencent-raw", fields: ["open", "high", "low", "close"], matchedRows: rows.length, priceTolerance: .005 } } };
    });
  }
  function sharedThsQuote(ctx, security, signal) {
    if (!ctx.quotes.has(security.secid)) {
      const pending = ths.quote({ code: security.code, secid: security.secid, assetType: "stock" }, { signal }).catch(error => {
        if (signal?.aborted) throw error;
        return null; // 没有快照时只用K线文件，不补当日。
      });
      ctx.quotes.set(security.secid, pending);
      if (ctx.quotes.size > 24) ctx.quotes.delete(ctx.quotes.keys().next().value);
    }
    return ctx.quotes.get(security.secid);
  }
  /** 同花顺主源；返回 null 表示这只证券改走应急源。 */
  async function thsHistory(ctx, security, adjustment, stage, signal) {
    if (!ths || ctx.ths.pausedUntil > clock()) return null;
    try {
      signal?.throwIfAborted();
      const quote = await sharedThsQuote(ctx, security, signal);
      const fetched = await ths.history({ code: security.code, secid: security.secid, assetType: "stock" },
        { limit: historyBars, fqt: adjustment === "front" ? 1 : 0, signal, now: new Date(now()).getTime(), quote });
      let rows = validateRows(fetched.map(row => ({ date: row.date, open: row.open, close: row.close, high: row.high, low: row.low,
        volume: row.volume, amount: row.amount, amplitude: row.amplitude ?? null, changePct: row.changePct ?? null,
        change: row.change ?? null, turnover: row.turnover ?? null,
        ...Object.fromEntries(["preClose", "previousClose", "upperLimit", "lowerLimit", "adjustmentFactor", "adjFactor", "corporateActionUnresolved", "noPriceLimit", "isST"]
          .filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]])) })), "同花顺");
      if (adjustment === "front") {
        // 与应急路径同口径：前复权只调价格，成交量/额取同一来源的不复权日线。
        const raw = await fetchHistory(security, "none", { signal });
        const byDate = new Map(raw.rows.map(row => [row.date, row]));
        // 本地日线库只存到 asOf（盘中是上一交易日），同花顺前复权会带上当天未收盘的一根：去掉不复权里还没有的日期再配对。
        const rawLast = raw.rows.at(-1)?.date;
        rows = rows.filter(row => !rawLast || row.date <= rawLast).map(row => {
          const original = byDate.get(row.date);
          if (!original) throw unavailable(`同花顺前复权与不复权日线日期不齐：${security.code} ${row.date}`);
          return { ...row, volume: original.volume, amount: original.amount };
        });
      }
      signal?.throwIfAborted();
      ctx.ths.faults = 0;
      const source = String(fetched?.dataSource || "").startsWith("fuyao") ? "ths-fuyao" : "ths-free";
      const result = { rows, adjustment, source, provenance: { source, amountUnit: "CNY", volumeUnit: "lot" } };
      record(ctx, stage, source, true, result);
      return result;
    } catch (error) {
      if (signal?.aborted || localCapacityError(error)) throw error;
      if (isThsProviderFault(error) && ++ctx.ths.faults >= THS_FAULT_LIMIT) ctx.ths.pausedUntil = clock() + THS_PAUSE_MS;
      record(ctx, stage, "ths-free", false, null, new Error(`同花顺未取到，已改用应急源：${error?.message || error}`));
      return null;
    }
  }
  async function fetchHistory(security, adjustment, { signal } = {}) {
    signal?.throwIfAborted();
    if (!/^\d{6}$/.test(security?.code) || !/^[01]\.\d{6}$/.test(security?.secid) || security.secid.slice(2) !== security.code || !["none", "front"].includes(adjustment)) throw unavailable("趋势扫描证券标识或复权参数无效");
    const ctx = context(signal), stage = adjustment === "none" ? "raw" : "adjusted";
    const storeDate = adjustment === "none" && dailyStore && typeof asOf === "function" ? asOf() : null;
    const cached = adjustment === "none" && ctx.raw.get(security.secid);
    if (cached) {
      const age = clock() - cached.at;
      if (cached.asOf === storeDate && age >= 0 && age < HISTORY_RETRY_MS) return cached.operation;
      ctx.raw.delete(security.secid);
    }
    const download = async () => (await thsHistory(ctx, security, adjustment, stage, signal)) || emergencyHistory(ctx, security, adjustment, stage, signal);
    const operation = storeDate ? dailyStore.history(security, storeDate, download, { bars: historyBars }) : download();
    if (adjustment === "none") {
      ctx.raw.set(security.secid, { operation, at: clock(), asOf: storeDate });
      // Only active workers need raw/front pairing; never retain the whole market's bars.
      if (ctx.raw.size > 24) ctx.raw.delete(ctx.raw.keys().next().value);
      operation.catch(() => { if (ctx.raw.get(security.secid)?.operation === operation) ctx.raw.delete(security.secid); });
    }
    return operation;
  }
  function emergencyHistory(ctx, security, adjustment, stage, signal) {
    return withFallback(ctx, stage, "push2his.eastmoney.com", signal, () => eastHistory(security, adjustment, { signal }),
      () => adjustment === "none" ? fallbackRaw(security, ctx, signal) : tracked(ctx, "adjusted", "tencent-qfq", signal, async () => {
        const raw = await fetchHistory(security, "none", { signal });
        const front = new Map((await tencentRows(security, "front", signal)).map(row => [row.date, row]));
        const rows = raw.rows.map(row => {
          const adjusted = front.get(row.date);
          if (!adjusted) throw unavailable(`腾讯前复权与原始日线日期不齐：${security.code} ${row.date}`);
          return { ...adjusted, volume: row.volume, amount: row.amount };
        });
        return { rows, adjustment: "front", source: "tencent-qfq", provenance: { source: "tencent-qfq", amountUnit: "CNY", volumeUnit: "lot", amountSource: raw.source } };
      }));
  }

  async function fetchBenchmark(options = {}) {
    const { signal } = options, ctx = context(signal), security = { code: "000985", secid: "1.000985" };
    if (typeof ths?.benchmark === "function") {
      // 同花顺扶摇提供中证全指日线（有 API Key 时）；取不到返回 null，继续走应急源。
      const rows = await ths.benchmark({ ...security, thscode: "000985.SH", assetType: "index", name: "中证全指" }, { limit: historyBars, signal }).catch(error => {
        if (signal?.aborted) throw error;
        return null;
      });
      if (Array.isArray(rows) && rows.length) {
        try {
          const valid = validateRows(rows.map(row => ({ date: row.date, open: row.open, high: row.high, low: row.low, close: row.close, volume: row.volume, amount: row.amount })), "同花顺扶摇中证全指", true);
          record(ctx, "benchmark", "fuyao-csi-000985", true, valid);
          Object.defineProperty(valid, "dataSource", { value: "fuyao-csi-000985", configurable: true });
          return valid;
        } catch (error) {
          record(ctx, "benchmark", "fuyao-csi-000985", false, null, error);
        }
      }
    }
    return withFallback(ctx, "benchmark", "push2his.eastmoney.com", signal,
      async () => (await eastHistory(security, "none", { ...options, priceOnly: true })).rows,
      () => tracked(ctx, "benchmark", "tencent-csi-000985", signal, () => tencentRows(security, "none", signal)));
  }
  /** 选股/扫描开始前为本地日线库预取当天收盘快照（批量），让大多数股票只需补一根。 */
  async function prepareHistories(securities) {
    const storeDate = dailyStore && typeof asOf === "function" ? asOf() : null;
    if (!storeDate) return { requested: 0, received: 0 };
    return dailyStore.prepareDay(securities, storeDate);
  }

  return { fetchUniversePage, fetchHistory, fetchBenchmark, prepareHistories,
    getDiagnostics: ({ signal } = {}) => ({ sources: structuredClone([...context(signal).sources.values()]) }) };
}

module.exports = { createTrendMarketData };
