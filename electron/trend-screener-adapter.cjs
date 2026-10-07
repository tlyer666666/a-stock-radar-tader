"use strict";

const { fetchJsonWithPolicy } = require("./http-client.cjs");

// This scanner needs amount and a confirmed adjustment basis. Do not silently
// substitute feeds whose daily bars omit those fields or change that basis.
function createTrendMarketData({ fetchJson = fetchJsonWithPolicy, now = () => new Date(), historyBars = 320 } = {}) {
  if (!Number.isInteger(historyBars) || historyBars < 20 || historyBars > 1500) throw new Error("historyBars必须为20至1500的整数");
  const contexts = new WeakMap();
  const newContext = () => ({ failedHosts: new Map(), sources: new Map(), raw: new Map(), universe: null });
  const defaultContext = newContext();
  const context = signal => {
    if (!signal) return defaultContext;
    if (!contexts.has(signal)) contexts.set(signal, newContext());
    return contexts.get(signal);
  };
  const unavailable = message => Object.assign(new Error(message), { code: "TREND_DATA_UNAVAILABLE" });
  const localCapacityError = error => ["QUEUE_FULL", "QUEUE_TIMEOUT"].includes(error?.code);
  function record(ctx, stage, source, ok, result, error) {
    const key = `${stage}:${source}`;
    const previous = ctx.sources.get(key) || { stage, source, status: "ok", successes: 0, failures: 0,
      latestDate: null, detail: "", crossCheckedRows: 0 };
    const rows = Array.isArray(result) ? result : result?.rows;
    const crossCheck = result?.provenance?.crossCheck;
    ctx.sources.set(key, { ...previous, status: ok ? "ok" : "error",
      successes: previous.successes + Number(ok), failures: previous.failures + Number(!ok),
      latestDate: rows?.at(-1)?.date || previous.latestDate,
      detail: ok ? crossCheck ? `OHLC原价逐日交叉核验${crossCheck.matchedRows}根；量额来自搜狐（手/万元→元），未跨源核验量额` : source === "tencent-csi-000985" ? "中证全指价格日线；未提供成交额，保持缺失" : "数据已返回并通过来源契约核对" : String(error?.message || "数据源失败"),
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
    let primaryError = ctx.failedHosts.get(host);
    if (!primaryError) {
      try { return await tracked(ctx, stage, "eastmoney", signal, primary); }
      catch (error) {
        if (signal?.aborted || error.code !== "MARKET_DATA_SOURCE_UNAVAILABLE" || error.providerRc !== undefined || [401, 403, 429].includes(error.status)) throw error;
        primaryError = error;
        ctx.failedHosts.set(host, error);
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
    const sohu = new URL(url).hostname === "q.stock.sohu.com";
    return fetchJson(url, { ...(signal ? { signal } : {}) }, { timeoutMs: 12000, retries: sohu ? 2 : 1, minimumGapMs: sohu ? 1000 : 180,
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
      for (let page = 1; rows.length < total; page++) {
        const data = await publicJson(`${base}getHQNodeData?page=${page}&num=100&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page`, signal, "https://finance.sina.com.cn/");
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

  async function eastUniversePage({ filter, page, pageSize, signal }) {
    const url = new URL("https://push2delay.eastmoney.com/api/qt/clist/get");
    const params = { pn: page, pz: pageSize, po: 0, np: 1, fltt: 2, invt: 2,
      ut: "bd1d9ddb04089700cf9c27f6f7426281", fs: filter, fid: "f12", fields: "f12,f14,f13,f100" };
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
    const json = await request(url.href, "universe", "证券名单", signal);
    const total = number(json?.data?.total);
    if (!Number.isInteger(total) || total < 0 || !Array.isArray(json?.data?.diff)) {
      throw new Error("证券名单缺少总数或分页记录，无法确认市场覆盖");
    }
    return { total, rows: json.data.diff.map(item => ({
      code: String(item.f12 || ""),
      name: String(item.f14 || ""),
      secid: `${Number(item.f13) === 1 ? 1 : 0}.${String(item.f12 || "")}`,
      industry: String(item.f100 || "未分类"),
      assetType: "stock"
    })) };
  }

  async function fetchUniversePage(options) {
    const { filter, page, pageSize, signal } = options;
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 1000) throw unavailable("证券名单分页参数无效");
    const ctx = context(signal);
    return withFallback(ctx, "universe", "push2delay.eastmoney.com", signal, () => eastUniversePage(options), async () => {
      const all = await sinaUniverse(ctx, signal), selected = all.filter(row => row.filter === filter);
      if (!["m:0+t:6", "m:1+t:2", "m:0+t:80", "m:1+t:23", "m:0+t:81+s:2048"].includes(filter)) throw unavailable("证券名单板块参数无效");
      return { total: selected.length, rows: selected.slice((page - 1) * pageSize, page * pageSize).map(({ filter: ignored, ...row }) => row), source: "sina-all-a" };
    });
  }

  async function eastHistory(security, adjustment, { signal } = {}) {
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
    return { rows, adjustment, source: "eastmoney" };
  }

  function validateRows(rows, label, priceOnly = false) {
    const sorted = [...rows].sort((a, b) => a.date.localeCompare(b.date));
    if (!sorted.length || sorted.some((row, i) => !/^\d{4}-\d{2}-\d{2}$/.test(row.date) ||
      !Number.isFinite(Date.parse(`${row.date}T00:00:00Z`)) || new Date(`${row.date}T00:00:00Z`).toISOString().slice(0, 10) !== row.date ||
      (i > 0 && row.date === sorted[i - 1].date) ||
      ![row.open, row.high, row.low, row.close].every(value => typeof value === "number" && Number.isFinite(value) && value > 0) ||
      row.low > Math.min(row.open, row.close) || row.high < Math.max(row.open, row.close) ||
      (!priceOnly && (!Number.isFinite(row.amount) || row.amount < 0 || !Number.isFinite(row.volume) || row.volume < 0)))) {
      throw unavailable(`${label}日期、价格或成交额字段缺失/无效`);
    }
    return sorted;
  }
  const symbolFor = security => `${security.secid.startsWith("1.") ? "sh" : /^(?:[48]|920)/.test(security.code) ? "bj" : "sz"}${security.code}`;
  async function tencentRows(security, adjustment, signal, priceOnly = false) {
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
  async function fetchHistory(security, adjustment, { signal } = {}) {
    signal?.throwIfAborted();
    if (!/^\d{6}$/.test(security?.code) || !/^[01]\.\d{6}$/.test(security?.secid) || security.secid.slice(2) !== security.code || !["none", "front"].includes(adjustment)) throw unavailable("趋势扫描证券标识或复权参数无效");
    const ctx = context(signal), stage = adjustment === "none" ? "raw" : "adjusted";
    if (adjustment === "none" && ctx.raw.has(security.secid)) return ctx.raw.get(security.secid);
    const operation = withFallback(ctx, stage, "push2his.eastmoney.com", signal, () => eastHistory(security, adjustment, { signal }),
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
    if (adjustment === "none") {
      ctx.raw.set(security.secid, operation);
      // Only active workers need raw/front pairing; never retain the whole market's bars.
      if (ctx.raw.size > 24) ctx.raw.delete(ctx.raw.keys().next().value);
      operation.catch(() => { if (ctx.raw.get(security.secid) === operation) ctx.raw.delete(security.secid); });
    }
    return operation;
  }

  async function fetchBenchmark(options = {}) {
    const { signal } = options, ctx = context(signal), security = { code: "000985", secid: "1.000985" };
    return withFallback(ctx, "benchmark", "push2his.eastmoney.com", signal,
      async () => (await eastHistory(security, "none", options)).rows,
      () => tracked(ctx, "benchmark", "tencent-csi-000985", signal, () => tencentRows(security, "none", signal, true)));
  }
  return { fetchUniversePage, fetchHistory, fetchBenchmark,
    getDiagnostics: ({ signal } = {}) => ({ sources: structuredClone([...context(signal).sources.values()]) }) };
}

module.exports = { createTrendMarketData };
