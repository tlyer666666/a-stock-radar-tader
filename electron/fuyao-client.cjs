"use strict";

/**
 * 同花顺「扶摇」金融数据接口（https://fuyao.aicubes.cn，官方 REST，免费，需 API Key）。
 *
 * 文档：https://fuyao.aicubes.cn/docs/api-reference/overview/
 * - 认证：请求头 X-api-key；业务结果在信封 { code, message, request_id, data } 里，code=0 成功。
 *   2001 Key 缺失/无效，2003 无权调用，4001 / HTTP 429 限流。
 * - 证券一律用完整 thscode（600519.SH / 000985.SH）。
 * - 时间为毫秒级 Unix 时间戳（Asia/Shanghai）。成交量单位为「股」。
 * - **成交额字段待核实**：官方文档称 turnover 为成交额（元），但中文行情接口里同名字段常指换手率；
 *   在拿到真实响应样本前，用 plausibleAmount() 做量纲核对（额 ÷ (量(股) × 价)），
 *   量纲明显不符时输出 null（fail-closed），避免把换手率当成交额喂给成交额阈值。
 *
 * 本模块只做请求与字段规整；是否启用、失败后切到哪条免费链路由调用方决定。
 */

const { fetchJsonWithPolicy } = require("./http-client.cjs");

const FUYAO_HOST = "https://fuyao.aicubes.cn";
const POLICY = Object.freeze({ timeoutMs: 8000, retries: 1, minimumGapMs: 120, queueTimeoutMs: 15000, maxResponseBytes: 4 * 1024 * 1024 });
const DAY_MS = 86400000;
const KEY_PATTERN = /^sk-fuyao-[A-Za-z0-9_-]{16,}$/;

function fuyaoError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, provider: "fuyao", ...extra });
}

function isFuyaoKey(value) {
  return KEY_PATTERN.test(String(value || "").trim());
}

/** “12.3万”“1.2亿”“45678” → 数值；无法解析返回 null。 */
const heatNumber = (value) => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const match = String(value ?? "").replace(/,/g, "").trim().match(/^(-?\d+(?:\.\d+)?)\s*(万|亿)?$/);
  if (!match) return null;
  return Number(match[1]) * (match[2] === "亿" ? 1e8 : match[2] === "万" ? 1e4 : 1);
};

const toNumber = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/** 成交额量纲校验（真实成交额应满足 额 ≈ Σ(量×价)，比值在 0.5~2 附近；
 *  换手率会小 6~7 个数量级）。越界判为「不是成交额」→ null，
 *  让下游成交额阈值不成立，而不是用错误数值通过。成交量/价格缺失时无法核对，保留原值。 */
const AMOUNT_RATIO_MIN = 0.05;
const AMOUNT_RATIO_MAX = 20;
function plausibleAmount(rawAmount, shares, price, { index = false } = {}) {
  const amount = toNumber(rawAmount);
  if (amount === null) return null;
  const quantity = toNumber(shares);
  const unitPrice = toNumber(price);
  if (!(quantity > 0) || !(unitPrice > 0)) return amount;
  if (index) {
    // 指数点位不是单股价格；成分股平均单价约在 1~500 元之间，指数成交额在千万以上。
    const impliedSharePrice = amount / quantity;
    return impliedSharePrice >= 1 && impliedSharePrice <= 500 && amount >= 1e7 ? amount : null;
  }
  const ratio = amount / (quantity * unitPrice);
  return ratio >= AMOUNT_RATIO_MIN && ratio <= AMOUNT_RATIO_MAX ? amount : null;
}

/** 毫秒时间戳 → 北京时间 YYYY-MM-DD。 */
function shanghaiDate(ms) {
  return new Date(Number(ms) + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 东方财富式 secid（1.600000 / 0.000001）或代码 → 扶摇 thscode。 */
function fuyaoThscode(security) {
  const explicit = String(security?.thscode || "").toUpperCase();
  if (/^\d{6}\.(SH|SZ|BJ)$/.test(explicit)) return explicit;
  const code = String(security?.code || "");
  if (!/^\d{6}$/.test(code)) return "";
  const secid = String(security?.secid || "");
  if (secid.startsWith("1.")) return `${code}.SH`;
  if (/^(?:[48]\d{5}|920\d{3})$/.test(code)) return `${code}.BJ`;
  if (secid.startsWith("0.")) return `${code}.SZ`;
  return /^(?:6|9)/.test(code) ? `${code}.SH` : `${code}.SZ`;
}

/** 沪市 000xxx、深市 399xxx 是指数；其余 6 位代码按个股处理。 */
function isIndexSecurity(security) {
  if (security?.assetType === "index") return true;
  const secid = String(security?.secid || "");
  return /^1\.000\d{3}$/.test(secid) || /^0\.399\d{3}$/.test(secid);
}

function createFuyaoClient({ getApiKey, fetchJson = fetchJsonWithPolicy, now = () => Date.now() } = {}) {
  const key = () => {
    const value = String((typeof getApiKey === "function" ? getApiKey() : "") || "").trim();
    return isFuyaoKey(value) ? value : "";
  };

  async function request(path, params = {}, { signal } = {}) {
    const apiKey = key();
    if (!apiKey) throw fuyaoError("未配置同花顺扶摇 API Key", "FUYAO_NO_KEY");
    const url = new URL(path, FUYAO_HOST);
    for (const [name, value] of Object.entries(params)) {
      if (value !== undefined && value !== null && value !== "") url.searchParams.set(name, String(value));
    }
    let json;
    try {
      json = await fetchJson(url.href, { ...(signal ? { signal } : {}) }, {
        ...POLICY,
        headers: { "X-api-key": apiKey, Accept: "application/json", "User-Agent": "A-Stock-Radar" }
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      if (Number(error?.status) === 429) throw fuyaoError("同花顺扶摇接口限流（HTTP 429）", "FUYAO_RATE_LIMITED", { status: 429, cause: error });
      throw fuyaoError(`同花顺扶摇接口请求失败：${error?.message || error}`, "FUYAO_NETWORK", { status: error?.status, cause: error });
    }
    const code = Number(json?.code);
    if (code !== 0) {
      const message = String(json?.message || "").slice(0, 160);
      const kind = code === 2001 ? "FUYAO_AUTH" : code === 2003 ? "FUYAO_FORBIDDEN" : code === 4001 ? "FUYAO_RATE_LIMITED" : "FUYAO_REJECTED";
      throw fuyaoError(`同花顺扶摇接口返回 code=${Number.isFinite(code) ? code : "缺失"}${message ? `：${message}` : ""}`, kind, { providerCode: code });
    }
    if (!json.data || typeof json.data !== "object") throw fuyaoError("同花顺扶摇接口没有返回 data", "FUYAO_EMPTY");
    return json.data;
  }

  const items = (data) => Array.isArray(data?.item) ? data.item : [];

  /** 日K线行，与本应用其他日线同形（volume 为「手」= 股/100）。 */
  function normalizeBars(data, label, { index = false } = {}) {
    const rows = [];
    for (const item of items(data)) {
      const ms = toNumber(item?.date_ms);
      const open = toNumber(item?.open_price), high = toNumber(item?.high_price), low = toNumber(item?.low_price), close = toNumber(item?.close_price);
      const shares = toNumber(item?.volume);
      if (ms === null || ![open, high, low, close].every((value) => value > 0)) continue;
      rows.push({ date: shanghaiDate(ms), open, high, low, close,
        volume: shares === null ? null : shares / 100, volumeUnit: "lots",
        amount: plausibleAmount(item?.turnover, shares, close, { index }) });
    }
    rows.sort((a, b) => a.date.localeCompare(b.date));
    const unique = rows.filter((row, index) => index === 0 || row.date !== rows[index - 1].date);
    if (!unique.length) throw fuyaoError(`同花顺扶摇${label}日线为空`, "FUYAO_EMPTY_HISTORY");
    return unique;
  }

  /** 日线：个股（复权可选）或指数。返回最近 limit 根，不含当天未收盘的快照合成。 */
  async function dailyHistory(security, { limit = 160, fqt = 1, signal } = {}) {
    const thscode = fuyaoThscode(security);
    if (!thscode) throw fuyaoError("扶摇日线缺少有效证券代码", "FUYAO_UNSUPPORTED");
    const index = isIndexSecurity(security);
    const wanted = Math.max(1, Math.min(2400, Math.round(Number(limit) || 160)));
    const end = now();
    // 交易日约占自然日 68%；多取一些再截尾。指数接口只给近 5 年，个股最长 10 年。
    const spanDays = Math.min(index ? 5 * 365 - 2 : 10 * 365 - 2, Math.ceil(wanted * 1.55) + 30);
    const params = { thscode, interval: "1d", start: end - spanDays * DAY_MS, end };
    if (!index) params.adjust = Number(fqt) === 0 ? "none" : Number(fqt) === 2 ? "backward" : "forward";
    const data = await request(index ? "/api/a-share-index/prices/historical" : "/api/a-share/prices/historical", params, { signal });
    const rows = normalizeBars(data, index ? "指数" : "个股", { index }).slice(-wanted);
    return Object.assign(rows, { thscode, index, adjustment: index ? 0 : Number(fqt) === 0 ? 0 : Number(fqt) === 2 ? 2 : 1 });
  }

  /** 行情快照（个股或指数，按代码批量），返回按 thscode 索引的 Map。 */
  async function snapshot(securities, { signal, index = false } = {}) {
    const codes = [...new Set(securities.map(fuyaoThscode).filter(Boolean))];
    if (!codes.length) return new Map();
    const out = new Map();
    // 文档未给批量上限，按 50 只一批保守请求。
    for (let offset = 0; offset < codes.length; offset += 50) {
      const batch = codes.slice(offset, offset + 50);
      const data = await request(index ? "/api/a-share-index/prices/snapshot" : "/api/a-share/prices/snapshot", { thscodes: batch.join(",") }, { signal });
      const at = toNumber(data?.timestamp);
      for (const item of items(data)) {
        const thscode = String(item?.thscode || "").toUpperCase();
        if (!batch.includes(thscode)) continue;
        const shares = toNumber(item?.volume);
        out.set(thscode, {
          thscode,
          code: String(item?.ticker || thscode.slice(0, 6)),
          latest: toNumber(item?.last_price),
          open: toNumber(item?.open_price),
          high: toNumber(item?.high_price),
          low: toNumber(item?.low_price),
          preClose: toNumber(item?.prev_price),
          change: toNumber(item?.price_change),
          changePct: toNumber(item?.price_change_ratio_pct),
          volume: shares === null ? null : shares / 100,
          volumeUnit: "lots",
          amount: plausibleAmount(item?.turnover, shares, toNumber(item?.last_price), { index }),
          quoteAt: at === null ? "" : new Date(at).toISOString(),
          source: "fuyao"
        });
      }
    }
    return out;
  }

  /** 同花顺指数/板块成分股（881xxx.TI / 885xxx.TI / 000300.SH）。 */
  async function constituents(thscode, { signal } = {}) {
    const data = await request("/api/a-share-index/constituents/ths-stock-list", { thscode }, { signal });
    return items(data).map((item) => ({ thscode: String(item?.thscode || "").toUpperCase(), code: String(item?.ticker || ""), name: String(item?.name || "") }))
      .filter((item) => /^\d{6}$/.test(item.code));
  }

  /** 近一年交易日（升序，YYYYMMDD）。 */
  async function tradingDays({ signal } = {}) {
    const data = await request("/api/a-share/calendar/trading-days", {}, { signal });
    return items(data).map((item) => String(item?.date || "")).filter((date) => /^\d{8}$/.test(date)).sort();
  }

  /** 北京时间某日 00:00 的毫秒时间戳（涨停/跌停/炸板池的 date_ms 参数）。 */
  const dayStartMs = (date) => Date.parse(`${date}T00:00:00+08:00`);

  /** 分页读取涨停/跌停/炸板池（每页最多 200，最多 5 页）。 */
  async function pool(path, { date, sortField, signal } = {}) {
    const rows = [];
    let total = null, at = null;
    for (let page = 1; page <= 5; page += 1) {
      const data = await request(path, { ...(date ? { date_ms: dayStartMs(date) } : {}), page, size: 200, ...(sortField ? { sort_field: sortField, sort_dir: "desc" } : {}) }, { signal });
      const list = items(data);
      at = toNumber(data?.timestamp) ?? at;
      total = toNumber(data?.pagination?.total) ?? total;
      rows.push(...list);
      if (!list.length || (total !== null && rows.length >= total) || list.length < 200) break;
    }
    return { rows, total: total ?? rows.length, fetchedAt: at === null ? "" : new Date(at).toISOString() };
  }

  const stock = (item) => ({ thscode: String(item?.thscode || "").toUpperCase(), code: String(item?.ticker || String(item?.thscode || "").slice(0, 6)), name: String(item?.name || item?.stock_name || "") });

  async function limitUpPool(options = {}) {
    const result = await pool("/api/a-share/special-data/limit-up-pool", { ...options, sortField: "continue_day_cnt" });
    return { ...result, rows: result.rows.map((item) => ({ ...stock(item), isSt: item?.is_st === true, isNew: item?.is_new === true,
      latest: toNumber(item?.last_price), changePct: toNumber(item?.price_change_ratio_pct), limitUpTime: String(item?.limit_up_time || ""),
      reason: String(item?.limit_up_reason || "").trim(), boards: toNumber(item?.continue_day_cnt), boardsText: String(item?.continue_day_text || ""),
      sealMoney: toNumber(item?.seal_money), maxSealMoney: toNumber(item?.max_seal_money) })) };
  }

  async function limitBreakPool(options = {}) {
    const result = await pool("/api/a-share/special-data/limit-break-pool", { ...options, sortField: "price_change_ratio_pct" });
    return { ...result, rows: result.rows.map((item) => ({ ...stock(item), latest: toNumber(item?.last_price), changePct: toNumber(item?.price_change_ratio_pct),
      openTimes: toNumber(item?.open_times), turnoverRate: toNumber(item?.turnover_ratio_pct),
      amount: (() => { const raw = toNumber(item?.turnover); return raw !== null && raw > 1e4 ? raw : null; })() })) };
  }

  async function limitDownPool(options = {}) {
    const result = await pool("/api/a-share/special-data/limit-down-pool", { ...options, sortField: "last_limit_time" });
    return { ...result, rows: result.rows.map((item) => ({ ...stock(item), latest: toNumber(item?.last_price), changePct: toNumber(item?.price_change_ratio_pct),
      firstLimitTime: String(item?.first_limit_time || ""), lastLimitTime: String(item?.last_limit_time || ""), turnoverRate: toNumber(item?.turnover_ratio_pct) })) };
  }

  const LADDER_TIERS = Object.freeze([["seven_over", 7], ["six_board", 6], ["five_board", 5], ["four_board", 4], ["three_board", 3], ["two_board", 2]]);
  /** 近 30 个交易日的连板天梯（每档最多 4 只）。 */
  async function limitUpLadder({ signal } = {}) {
    const data = await request("/api/a-share/special-data/limit-up-ladder", {}, { signal });
    const days = items(data).map((item) => ({
      date: String(item?.date || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3"),
      tiers: LADDER_TIERS.map(([key, level]) => ({ level, label: level >= 7 ? "7板以上" : `${level}板`,
        stocks: (Array.isArray(item?.boards?.[key]) ? item.boards[key] : []).map((row) => ({ ...stock(row), boards: toNumber(row?.board_num),
          nextDay: row?.seal_nextday === null || row?.seal_nextday === undefined ? null : String(row.seal_nextday) })) }))
    })).filter((day) => day.date).sort((a, b) => a.date.localeCompare(b.date));
    const at = toNumber(data?.timestamp);
    return { days, fetchedAt: at === null ? "" : new Date(at).toISOString() };
  }

  // 热度是接口给的原始字符串（可能带“万/亿”）：原样保留文字，另解析一个数值供排序。
  const rankRows = (data) => items(data).map((item) => ({ ...stock(item), rank: toNumber(item?.rank), heat: heatNumber(item?.heat),
    heatText: item?.heat === null || item?.heat === undefined ? "" : String(item.heat).trim(),
    rankChange: toNumber(item?.rank_change), rankTrend: String(item?.rank_trend || "") })).filter((row) => row.code)
    .sort((a, b) => (a.rank ?? 1e9) - (b.rank ?? 1e9));
  const hotPeriod = (period) => {
    if (period !== "day" && period !== "hour") throw fuyaoError("热榜周期只能是 hour（1小时）或 day（24小时）", "FUYAO_UNSUPPORTED");
    return period;
  };
  /** 同花顺热股榜：hour=1小时榜，day=24小时榜（与同花顺App热榜两个页签一致），各最多30条。 */
  async function hotStocks({ period = "day", signal } = {}) {
    const data = await request("/api/a-share/special-data/hot-stock-list", { period: hotPeriod(period) }, { signal });
    return rankRows(data);
  }
  async function skyrocket({ period = "day", signal } = {}) {
    const data = await request("/api/a-share/special-data/skyrocket-list", { period: hotPeriod(period) }, { signal });
    return rankRows(data);
  }

  /** 龙虎榜（不传日期 = 最近一个有数据的交易日）。 */
  const ratioPct = (value) => { const number = toNumber(value); return number === null ? null : Math.round(number * 10000) / 100; };

  async function dragonTiger({ date, signal } = {}) {
    const data = await request("/api/a-share/special-data/dragon-tiger-list", { board_type: "all", ...(date ? { date } : {}) }, { signal });
    const stocks = (Array.isArray(data?.stock_items) ? data.stock_items : []).map((item) => ({ ...stock(item),
      concepts: Array.isArray(item?.concept_list) ? item.concept_list.map(String).slice(0, 6) : [],
      // 龙虎榜的 change 是小数比例（0.1 = 10%），和各涨停池的 price_change_ratio_pct（已是百分数）不同；
      // 2026-11-06 实际数据：主板涨停股为 0.1、创业板 0.2。统一换成百分数。
      changePct: ratioPct(item?.change), buy: toNumber(item?.buy_value), sell: toNumber(item?.sell_value), net: toNumber(item?.net_value),
      netRate: toNumber(item?.net_rate), orgNet: toNumber(item?.org_net_value), hotMoneyNet: toNumber(item?.hot_money_net_value),
      days: toNumber(item?.range_days), reason: String(item?.limit_reason || "") }));
    const desks = (Array.isArray(data?.hot_money_items) ? data.hot_money_items : []).map((item) => ({ name: String(item?.name || ""), buying: toNumber(item?.buying),
      stocks: (Array.isArray(item?.rows) ? item.rows : []).map((row) => ({ ...stock(row), net: toNumber(row?.hot_money_item_net_value) })).slice(0, 6) }))
      .filter((desk) => desk.name);
    return { date: String(data?.trade_date || ""), count: toNumber(data?.count), stocks, desks };
  }

  /** 当日异动原因（涨停/跌停/急涨/急跌等）。 */
  async function anomalies({ tags = [], signal } = {}) {
    const data = await request("/api/a-share/special-data/anomaly-analysis-list", tags.length ? { tag_codes: tags.join(",") } : {}, { signal });
    const at = toNumber(data?.timestamp);
    return { fetchedAt: at === null ? "" : new Date(at).toISOString(), rows: items(data).map((item) => ({ ...stock(item), name: String(item?.stock_name || item?.name || ""),
      tag: String(item?.tag_name || ""), content: String(item?.analysis_content || "").trim(),
      keywords: Array.isArray(item?.keyword_list) ? item.keyword_list.map(String).slice(0, 8) : [] })).filter((row) => row.thscode && row.content) };
  }

  /** 连通性自检：用两只大盘股快照。 */
  async function probe({ signal } = {}) {
    const started = now();
    const quotes = await snapshot([{ code: "600519", secid: "1.600519" }, { code: "000001", secid: "0.000001" }], { signal });
    const first = quotes.get("600519.SH");
    if (!first || !(first.latest > 0)) throw fuyaoError("同花顺扶摇快照没有返回有效价格", "FUYAO_EMPTY");
    return { ok: true, latencyMs: now() - started, sample: `贵州茅台 ${first.latest}` };
  }

  return { configured: () => Boolean(key()), request, dailyHistory, snapshot, constituents, tradingDays, probe,
    limitUpPool, limitBreakPool, limitDownPool, limitUpLadder, hotStocks, skyrocket, dragonTiger, anomalies };
}

module.exports = { createFuyaoClient, fuyaoThscode, isIndexSecurity, isFuyaoKey, shanghaiDate, FUYAO_HOST };
