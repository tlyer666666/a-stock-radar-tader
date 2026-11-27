"use strict";

/**
 * 同花顺免费行情网关（d.10jqka.com.cn）—— 个股实时报价与日K线。
 *
 * 这是同花顺个股页（stockpage.10jqka.com.cn）自己在用的公开接口，不需要
 * QuantAPI Refresh Token。与付费的 QuantAPI（quantapi.51ifind.com）是两条独立链路：
 *
 *   实时快照  /v6/realhead/hs_{code}/last.js        JSONP，items 为字段编号 → 值
 *   日K线      /v6/line/hs_{code}/{00|01|02}/{year}.js  按年整年；00 不复权 / 01 前复权 / 02 后复权
 *   最近日K    /v6/line/hs_{code}/{adj}/last.js       只含最近约 140 根，作年文件失败时的兜底
 *   五档盘口  /v2/fiverange/hs_{code}/last.js        JSONP，买一~买五、卖一~卖五（量单位为「股」）
 *
 * 2026-10-21 实测要点（写测试用的样本即来自这些响应的格式）：
 *   · realhead 的 `time` 是服务器出数时间（"2026-10-21 23:13:51 北京时间"），
 *     `updateTime` 是行情本身的时间（"2026-10-21 15:00"），`stockStatus` 为「闭市」「连续竞价」等。
 *     盘中用两者之差判断是否陈旧，陈旧时视为本路失败，交给东方财富/腾讯接力。
 *   · 不要用 /defer/ 变体：同一时刻它返回的是数周前的缓存快照。
 *   · 日K线文件不一定包含当天完整K线：收盘后当天行可能只有收盘价、其余为空（成交量 0）。
 *     解析时丢弃这种占位行，并用实时快照补出当天K线。
 *   · K线成交量单位是「股」，本应用统一用「手」，读取时除以 100。
 *
 * 字段编号（realhead items）：
 *   5=代码 10=现价 6=昨收 7=开盘 8=最高 9=最低 13=成交量(股) 19=成交额(元)
 *   199112=涨跌幅(%) 264648=涨跌额 1968584=换手率(%) 526792=振幅(%) 1771976=量比
 *   69=涨停价 70=跌停价 3475914=总市值(元) 3541450=流通市值(元)
 */

const { fetchArrayBufferWithPolicy } = require("./http-client.cjs");
const { thsHeaders, unwrapJsonp, num } = require("./ths-quote.cjs");
const { getHexinToken } = require("./ths-hexin-v.cjs");

const THS_FREE_HOST = "https://d.10jqka.com.cn";
const THS_STOCK_REFERER = "https://stockpage.10jqka.com.cn/";
const QUOTE_POLICY = Object.freeze({ timeoutMs: 4000, retries: 1, minimumGapMs: 60, queueTimeoutMs: 6000, maxResponseBytes: 256 * 1024 });
const LINE_POLICY = Object.freeze({ timeoutMs: 8000, retries: 1, minimumGapMs: 80, queueTimeoutMs: 12000, maxResponseBytes: 2 * 1024 * 1024 });
/** 盘中行情时间落后服务器时间超过该秒数即视为陈旧。 */
const MAX_TRADING_LAG_SECONDS = 180;
const ADJUSTMENT_PATH = Object.freeze({ 0: "00", 1: "01", 2: "02" });

function thsFreeError(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, provider: "ths_free", ...extra });
}

const THS_SH_INDEX_CODES = Object.freeze({
  "000001": "1A0001",
  "000300": "1B0300",
  "000905": "1B0905",
  "000852": "1B0852",
  "000016": "1B0016",
  "000688": "1B0688"
});

function isImplicitIndexSecurity(security) {
  if (String(security?.assetType || "") === "index") return true;
  const secid = String(security?.secid || "");
  if (/^1\.000\d{3}$/.test(secid) || /^0\.399\d{3}$/.test(secid)) return true;
  const thscode = String(security?.thscode || "").toUpperCase();
  return /^(?:000\d{3}\.SH|399\d{3}\.SZ|\d{6}\.TI)$/.test(thscode);
}

/**
 * 解析同花顺免费网关目标市场与代码：
 * - 沪市 000xxx / 深市 399xxx / 显式 index 严禁按深市个股 hs_000xxx 请求（避免 000985.SH 撞号 000985.SZ 大庆华科等）；
 * - 已知同花顺指数映射为对应网关代码（000001 -> hs_1A0001、000300 -> hs_1B0300），中证全指 000985 等返回 null 交由东财/腾讯等源处理。
 */
function resolveThsFreeSymbol(security) {
  const code = String(security?.code || "");
  if (isImplicitIndexSecurity(security)) {
    const market = String(security?.thsMarket || "");
    if (/^(?:48|hs)$/.test(market) && /^[0-9A-Z]{6}$/.test(code)) {
      return { market, code };
    }
    const secid = String(security?.secid || "");
    const thscode = String(security?.thscode || "").toUpperCase();
    const isShIndex = (!secid && !thscode)
      ? Boolean(THS_SH_INDEX_CODES[code])
      : (secid.startsWith("1.") || thscode.endsWith(".SH"));
    if (isShIndex && THS_SH_INDEX_CODES[code]) {
      return { market: "hs", code: THS_SH_INDEX_CODES[code] };
    }
    return null;
  }
  const assetType = String(security?.assetType || "stock");
  if (!/^\d{6}$/.test(code)) return null;
  if (assetType === "stock") return { market: "hs", code };
  if (assetType === "convertibleBond") {
    if (/^11[0138]\d{3}$/.test(code)) return { market: "19", code };
    if (/^12[378]\d{3}$/.test(code)) return { market: "35", code };
  }
  return null;
}

/** 免费网关覆盖沪深京 A 股个股、可转债及已映射指数；中证全指 000985、ETF 等交给东方财富/腾讯。 */
function thsFreeSupports(security) {
  return resolveThsFreeSymbol(security) !== null;
}

/** 成交量换算为「手」：股票 1 手 = 100 股；可转债 1 手 = 10 张。 */
function lotSize(security) {
  return String(security?.assetType || "stock") === "convertibleBond" ? 10 : 100;
}

function requestHeaders() {
  const headers = thsHeaders(THS_STOCK_REFERER);
  const token = getHexinToken();
  if (token) headers.Cookie = `v=${token}`;
  return headers;
}

async function readJsonp(url, policy, signal) {
  const bytes = await fetchArrayBufferWithPolicy(url, { headers: requestHeaders(), signal }, policy);
  return unwrapJsonp(new TextDecoder("utf-8").decode(bytes));
}

/** "2026-10-21 23:13:51 北京时间" / "2026-10-21 15:00" → epoch ms（按北京时间解释）。 */
function parseBeijingTime(value) {
  const match = String(value || "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = "00"] = match;
  const ms = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}+08:00`);
  return Number.isFinite(ms) ? ms : null;
}

function beijingDate(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

/** 交易所处于连续交易/竞价阶段（盘中）时才做陈旧判断；闭市、午休、停牌不判。 */
function isTradingStatus(status) {
  const text = String(status || "");
  if (!text || /闭市|收盘|休市|停牌|午间|未开盘|盘后|退市/.test(text)) return false;
  return /交易|竞价|盘中/.test(text);
}

/** 仅根据源端明确给出的状态文本/字段判定是否停牌；状态缺失或未知时保持 null，绝不猜测 false。 */
function parseSuspendedStatus(status) {
  if (typeof status === "boolean") return status;
  const text = String(status || "").trim();
  if (!text) return null;
  if (/^(?:suspended|delisted|halted)$/i.test(text) || /停牌|暂停交易|暂停上市/.test(text)) return true;
  if (/^(?:trading|open|closed|normal)$/i.test(text) || /交易|竞价|盘中|闭市|收盘|休市|午间|午休|未开盘|盘后|正常|开市/.test(text)) return false;
  return null;
}

function decimalsOf(text) {
  const value = String(text || "");
  const dot = value.indexOf(".");
  if (dot < 0) return 2;
  const fraction = value.slice(dot + 1).replace(/0+$/, "");
  return Math.max(2, Math.min(3, fraction.length));
}

function missingQuoteFields(values) {
  return ["latest", "changePct", "turnover", "amount"].filter((field) => !Number.isFinite(values[field]));
}

/**
 * realhead items → 本应用统一的报价结构（与东方财富 eastQuote 同形，source = "ths_free"）。
 * 会抛出：代码不匹配、无有效价格、缺少行情时间、盘中陈旧。
 */
function normalizeThsFreeQuote(security, items) {
  if (!items || typeof items !== "object") throw thsFreeError("同花顺免费行情未返回数据", "THS_FREE_EMPTY");
  const code = String(items["5"] || "");
  const expectedTarget = resolveThsFreeSymbol(security);
  if (code !== security.code && code !== expectedTarget?.code) {
    throw thsFreeError(`同花顺免费行情代码不匹配（${code || "空"}）`, "THS_FREE_MISMATCH");
  }
  const latest = num(items["10"]);
  if (!(latest > 0)) throw thsFreeError("同花顺免费行情未返回有效现价", "THS_FREE_NO_PRICE");
  const updatedMs = parseBeijingTime(items.updateTime);
  if (updatedMs === null) throw thsFreeError("同花顺免费行情缺少行情时间", "THS_FREE_NO_TIME");
  const serverMs = parseBeijingTime(items.time);
  const status = String(items.stockStatus || "");
  const lagSeconds = serverMs === null ? null : Math.round((serverMs - updatedMs) / 1000);
  if (isTradingStatus(status) && lagSeconds !== null && lagSeconds > MAX_TRADING_LAG_SECONDS) {
    throw thsFreeError(`同花顺免费行情盘中已 ${lagSeconds} 秒未更新`, "THS_FREE_STALE", { lagSeconds });
  }
  const preClose = num(items["6"]);
  const shares = num(items["13"]);
  const changePct = num(items["199112"]) ?? (preClose > 0 ? (latest / preClose - 1) * 100 : null);
  const values = {
    latest,
    changePct,
    turnover: num(items["1968584"]),
    amount: num(items["19"])
  };
  return {
    code: String(security.code || code),
    name: String(items.name || security.name || code),
    secid: security.secid,
    thscode: security.thscode,
    assetType: security.assetType || "stock",
    assetLabel: security.marketName || "A股",
    pricePrecision: decimalsOf(items["10"]),
    latest,
    high: num(items["8"]),
    low: num(items["9"]),
    open: num(items["7"]),
    volume: shares === null ? null : shares / lotSize(security),
    volumeUnit: "lots",
    amount: values.amount,
    volumeRatio: num(items["1771976"]),
    limitUp: num(items["69"]),
    limitDown: num(items["70"]),
    preClose,
    totalMarketCap: num(items["3475914"]),
    floatMarketCap: num(items["3541450"]),
    // 免费网关不给行业；留空让调用方用缓存或保留原值，避免把真实行业覆盖成「未分类」。
    industry: String(security.industry || ""),
    turnover: values.turnover,
    change: num(items["264648"]) ?? (preClose > 0 ? latest - preClose : null),
    changePct,
    amplitude: num(items["526792"]),
    quoteAt: new Date(updatedMs).toISOString(),
    marketStatus: status,
    ...(typeof items.suspended === "boolean"
      ? { suspended: items.suspended }
      : parseSuspendedStatus(items.tradeStatus ?? status) !== null
        ? { suspended: parseSuspendedStatus(items.tradeStatus ?? status) }
        : {}),
    lagSeconds,
    source: "ths_free",
    missingFields: missingQuoteFields(values)
  };
}

async function thsFreeQuote(security, { signal } = {}) {
  const target = resolveThsFreeSymbol(security);
  if (!target) throw thsFreeError("同花顺免费行情只覆盖A股个股与可转债", "THS_FREE_UNSUPPORTED");
  const payload = await readJsonp(`${THS_FREE_HOST}/v6/realhead/${target.market}_${target.code}/last.js`, QUOTE_POLICY, signal);
  const items = payload?.items;
  // 个别品种把代码/时间放在 items 外层；合并后再按同一口径校验。
  if (items && typeof items === "object" && items["5"] === undefined && payload["5"] !== undefined) {
    const outer = Object.fromEntries(["5", "name", "updateTime", "time", "stockStatus"].filter((key) => payload[key] !== undefined).map((key) => [key, payload[key]]));
    return normalizeThsFreeQuote(security, { ...items, ...outer });
  }
  return normalizeThsFreeQuote(security, items);
}

/**
 * 五档字段编号（2026-11-26 实测）：买一 24/25、买二 26/27、买三 28/29、买四 150/151、买五 154/155；
 * 卖一 30/31、卖二 32/33、卖三 34/35、卖四 152/153、卖五 156/157。量是「股」，换算成「手」。
 * 涨停封死时卖盘价为空、量为 0，这些档位不列出。
 */
const FIVE_RANGE_FIELDS = Object.freeze({
  bids: [["24", "25"], ["26", "27"], ["28", "29"], ["150", "151"], ["154", "155"]],
  asks: [["30", "31"], ["32", "33"], ["34", "35"], ["152", "153"], ["156", "157"]]
});

function parseThsFiveRange(items, unitsPerLot = 100) {
  if (!items || typeof items !== "object") throw thsFreeError("同花顺五档未返回数据", "THS_FREE_EMPTY");
  const side = pairs => pairs.map(([priceKey, volumeKey]) => {
    const price = num(items[priceKey]);
    const shares = num(items[volumeKey]);
    return price > 0 && shares > 0 ? { price, volumeLots: shares / unitsPerLot } : null;
  }).filter(Boolean);
  return { bids: side(FIVE_RANGE_FIELDS.bids), asks: side(FIVE_RANGE_FIELDS.asks), preClose: num(items["6"]) };
}

async function thsFreeFiveRange(security, { signal } = {}) {
  const target = resolveThsFreeSymbol(security);
  if (!target) throw thsFreeError("同花顺五档只覆盖A股个股与可转债", "THS_FREE_UNSUPPORTED");
  const payload = await readJsonp(`${THS_FREE_HOST}/v2/fiverange/${target.market}_${target.code}/last.js`, QUOTE_POLICY, signal);
  return parseThsFiveRange(payload?.items, lotSize(security));
}

/** K线 data 串 → 行（丢弃当天只有收盘价的占位行）。 */
function parseThsLineData(raw, unitsPerLot = 100) {
  const rows = [];
  for (const line of String(raw || "").split(";")) {
    const cells = line.split(",");
    if (cells.length < 6 || !/^\d{8}$/.test(cells[0])) continue;
    const open = num(cells[1]);
    const high = num(cells[2]);
    const low = num(cells[3]);
    const close = num(cells[4]);
    const shares = num(cells[5]);
    if (![open, high, low, close].every((value) => value > 0) || shares === null) continue;
    rows.push({
      date: `${cells[0].slice(0, 4)}-${cells[0].slice(4, 6)}-${cells[0].slice(6, 8)}`,
      open, high, low, close,
      volume: shares / unitsPerLot,
      volumeUnit: "lots",
      amount: num(cells[6]),
      turnover: num(cells[7])
    });
  }
  return rows;
}

/** 用实时快照补当天K线（同一天则覆盖，晚于最后一行则追加）。只用于不复权/前复权。 */
function mergeQuoteIntoDailyRows(rows, quote) {
  if (!quote || !(quote.latest > 0) || !(quote.open > 0) || !(quote.high > 0) || !(quote.low > 0)) return rows;
  const quoteMs = Date.parse(String(quote.quoteAt || ""));
  if (!Number.isFinite(quoteMs)) return rows;
  const date = beijingDate(quoteMs);
  const last = rows.at(-1);
  if (last && date < last.date) return rows;
  const bar = {
    date,
    open: quote.open,
    high: Math.max(quote.high, quote.latest),
    low: Math.min(quote.low, quote.latest),
    close: quote.latest,
    volume: Number.isFinite(quote.volume) ? quote.volume : null,
    volumeUnit: "lots",
    amount: Number.isFinite(quote.amount) ? quote.amount : null,
    turnover: Number.isFinite(quote.turnover) ? quote.turnover : null
  };
  // The exchange reference may differ from the preceding raw close on an
  // ex-rights date. Keep that evidence for the quant price-basis guard.
  for (const key of ["preClose", "change", "changePct", "amplitude"]) {
    if (Number.isFinite(quote[key]) && (key !== "preClose" || quote[key] > 0)) bar[key] = quote[key];
  }
  if (Number.isFinite(quote.limitUp) && quote.limitUp > 0) bar.upperLimit = quote.limitUp;
  if (Number.isFinite(quote.limitDown) && quote.limitDown > 0) bar.lowerLimit = quote.limitDown;
  return last && last.date === date ? [...rows.slice(0, -1), bar] : [...rows, bar];
}

/** 补齐与东方财富日线同口径的派生字段：昨收、涨跌额、涨跌幅、振幅。
 * 不复权日线（preserveMissingBasis=true）仅在源端已提供昨收时计算，不把前一日原始收盘伪装成交易所除权参考价。 */
function withDerivedFields(rows, { preserveMissingBasis = false } = {}) {
  return rows.map((row, index) => {
    const hasOwnPreClose = Number.isFinite(row.preClose) && row.preClose > 0;
    const previous = hasOwnPreClose ? row.preClose : preserveMissingBasis ? null : rows[index - 1]?.close;
    if (!(previous > 0)) {
      if (preserveMissingBasis) {
        const clean = { ...row };
        for (const key of ["preClose", "change", "changePct", "amplitude"]) {
          if (!Number.isFinite(clean[key])) delete clean[key];
        }
        return clean;
      }
      return { ...row, ...Object.fromEntries(["change", "changePct", "amplitude"]
        .map(key => [key, Number.isFinite(row[key]) ? row[key] : null])) };
    }
    return {
      ...row,
      preClose: previous,
      change: Number.isFinite(row.change) ? row.change : Number((row.close - previous).toFixed(4)),
      changePct: Number.isFinite(row.changePct) ? row.changePct : Number(((row.close / previous - 1) * 100).toFixed(4)),
      amplitude: Number.isFinite(row.amplitude) ? row.amplitude : Number((((row.high - row.low) / previous) * 100).toFixed(4))
    };
  });
}

/**
 * 日K线：按年文件向前取，直到够 limit 根（最多回溯 12 年）。
 * 当年文件取不到时用 last.js 兜底；fqt 为 0/1 时用实时快照补当天K线。
 */
async function thsFreeDailyHistory(security, { limit = 160, fqt = 1, signal, now = Date.now(), quote } = {}) {
  const target = resolveThsFreeSymbol(security);
  if (!target) throw thsFreeError("同花顺免费日线只覆盖A股个股", "THS_FREE_UNSUPPORTED");
  const adjustment = ADJUSTMENT_PATH[Number(fqt)] ? Number(fqt) : 1;
  const path = ADJUSTMENT_PATH[adjustment];
  const wanted = Math.max(1, Math.min(3000, Math.round(Number(limit) || 160)));
  const base = `${THS_FREE_HOST}/v6/line/${target.market}_${target.code}/${path}`;
  const unitsPerLot = lotSize(security);
  const byDate = new Map();
  const add = (rows) => { for (const row of rows) if (!byDate.has(row.date)) byDate.set(row.date, row); };
  const currentYear = Number(beijingDate(now).slice(0, 4));
  let failedYear = null;
  for (let year = currentYear; year >= currentYear - 12 && byDate.size < wanted + 1; year -= 1) {
    let rows;
    try {
      rows = parseThsLineData((await readJsonp(`${base}/${year}.js`, LINE_POLICY, signal))?.data, unitsPerLot);
    } catch (error) {
      if (signal?.aborted) throw error;
      failedYear = year;
      break; // Never bridge a failed year with older observations.
    }
    if (!rows.length && !byDate.size) { failedYear = year; break; }
    if (!rows.length && byDate.size) break; // 早于上市年份
    add(rows);
  }
  if (failedYear !== null || !byDate.size) {
    try {
      add(parseThsLineData((await readJsonp(`${base}/last.js`, LINE_POLICY, signal))?.data, unitsPerLot));
    } catch (error) {
      if (signal?.aborted || !byDate.size) throw error;
    }
    // last.js may independently provide the whole requested tail. Otherwise a
    // failed year is incomplete, even when another year has enough old rows.
    if (failedYear !== null && byDate.size < wanted) {
      throw thsFreeError(`同花顺${failedYear}年日线读取失败，最近窗口不足${wanted}根，切换备用源`, "THS_FREE_INCOMPLETE_HISTORY");
    }
  }
  let rows = [...byDate.values()].sort((left, right) => left.date.localeCompare(right.date));
  if (!rows.length) throw thsFreeError("同花顺免费日线为空", "THS_FREE_EMPTY_HISTORY");
  if (adjustment !== 2) {
    let latestQuote = quote || null;
    if (!latestQuote) {
      try { latestQuote = await thsFreeQuote(security, { signal }); } catch (error) {
        if (signal?.aborted) throw error;
      }
    }
    rows = mergeQuoteIntoDailyRows(rows, latestQuote);
  }
  const result = withDerivedFields(rows, { preserveMissingBasis: adjustment === 0 }).slice(-wanted);
  Object.defineProperty(result, "dataSource", { value: adjustment === 1 ? "ths_free_qfq" : adjustment === 2 ? "ths_free_hfq" : "ths_free_unadjusted", enumerable: false });
  Object.defineProperty(result, "actualAdjustment", { value: adjustment, enumerable: false });
  return result;
}

/**
 * 同花顺 K 线周期代码（v6/line/{市场}_{代码}/{周期}/last.js）。2026-10-23 实测：
 *   日线 00/01/02（不复权/前复权/后复权，按年文件见 thsFreeDailyHistory）
 *   周线 10/11/12、月线 20/21/22：last.js 即全部历史
 *   分钟：60 = 1 分钟、30 = 5 分钟、40 = 30 分钟、50 = 60 分钟（各约 140 根，不复权）
 *   15 分钟、120 分钟没有直接周期，由 5 分钟、60 分钟合成。
 */
const MINUTE_PERIODS = Object.freeze({ "1": { path: "60" }, "5": { path: "30" }, "15": { path: "30", group: 3, sourceMinutes: 5 }, "30": { path: "40" }, "60": { path: "50" }, "120": { path: "50", group: 2, sourceMinutes: 60 } });

function parseThsMinuteData(raw, unitsPerLot = 100) {
  const rows = [];
  for (const line of String(raw || "").split(";")) {
    const cells = line.split(",");
    if (cells.length < 6 || !/^\d{12}$/.test(cells[0])) continue;
    const open = num(cells[1]), high = num(cells[2]), low = num(cells[3]), close = num(cells[4]), units = num(cells[5]);
    if (![open, high, low, close].every((value) => value > 0) || units === null) continue;
    const t = cells[0];
    rows.push({ date: `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)} ${t.slice(8, 10)}:${t.slice(10, 12)}`, open, high, low, close,
      volume: units / unitsPerLot, volumeUnit: "lots", amount: num(cells[6]), turnover: num(cells[7]) });
  }
  return rows;
}

/** End-stamped source bars are grouped by exchange clock, separately for each half-day. */
function groupMinuteRows(rows, size, sourceMinutes = 5, now = Date.now()) {
  const out = [];
  const observationTime = Number(now);
  let bucket = [];
  let bucketKey = "", bucketStart = 0, bucketEnd = 0, completePrefix = true;
  const intervalMinutes = size * sourceMinutes;
  const flush = (allowPartial = false) => {
    if (!bucket.length) return;
    const dayStart = Date.parse(`${bucket[0].date.slice(0, 10)}T00:00:00+08:00`);
    // A missing historical tail is a data gap, even at the end of last.js.
    // Only the same half-day's currently forming clock bucket may be partial.
    const forming = allowPartial && Number.isFinite(observationTime) &&
      observationTime >= dayStart + bucketStart * 60000 && observationTime < dayStart + bucketEnd * 60000;
    if (completePrefix && (bucket.length === size || forming)) {
      const sum = (key) => bucket.every((row) => Number.isFinite(row[key])) ? bucket.reduce((total, row) => total + row[key], 0) : null;
      const end = `${String(Math.floor(bucketEnd / 60)).padStart(2, "0")}:${String(bucketEnd % 60).padStart(2, "0")}`;
      out.push({ date: `${bucket[0].date.slice(0, 10)} ${end}`, open: bucket[0].open, close: bucket.at(-1).close,
        high: Math.max(...bucket.map((row) => row.high)), low: Math.min(...bucket.map((row) => row.low)),
        volume: sum("volume") ?? 0, volumeUnit: "lots", amount: sum("amount"), turnover: sum("turnover") });
    }
    bucket = [];
  };
  for (const row of rows) {
    const match = String(row.date).match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/);
    if (!match) { flush(); continue; }
    const minute = Number(match[2]) * 60 + Number(match[3]);
    const sessionStart = minute > 570 && minute <= 690 ? 570 : minute > 780 && minute <= 900 ? 780 : null;
    if (sessionStart === null || (minute - sessionStart) % sourceMinutes) { flush(); continue; }
    const slot = Math.ceil((minute - sessionStart) / intervalMinutes);
    const key = `${match[1]}:${sessionStart}:${slot}`;
    if (key !== bucketKey || !bucket.length) {
      flush();
      bucketKey = key;
      bucketStart = sessionStart + (slot - 1) * intervalMinutes;
      bucketEnd = Math.min(sessionStart + slot * intervalMinutes, sessionStart + 120);
      completePrefix = minute === bucketStart + sourceMinutes;
    } else {
      const last = bucket.at(-1).date;
      const lastMinute = Number(last.slice(11, 13)) * 60 + Number(last.slice(14, 16));
      if (minute !== lastMinute + sourceMinutes) completePrefix = false;
    }
    bucket.push(row);
  }
  flush(true);
  return out;
}

/**
 * 图表 K 线：周期与东方财富接口一致（"1","5","15","30","60","120","101","102","103"）。
 * 返回行结构与 eastmoneyKlineRow 相同，dataSource 标为 ths_free_*。
 */
async function thsFreeKline(security, { interval = "101", limit = 160, fqt = 1, signal, now = Date.now() } = {}) {
  const target = resolveThsFreeSymbol(security);
  if (!target) throw thsFreeError("同花顺免费K线只覆盖A股个股与可转债", "THS_FREE_UNSUPPORTED");
  const klt = String(interval);
  const wanted = Math.max(1, Math.min(3000, Math.round(Number(limit) || 160)));
  const adjustment = ADJUSTMENT_PATH[Number(fqt)] ? Number(fqt) : 1;
  const base = `${THS_FREE_HOST}/v6/line/${target.market}_${target.code}`;
  const unitsPerLot = lotSize(security);
  const tag = (rows, source, actualAdjustment) => {
    Object.defineProperty(rows, "dataSource", { value: source, enumerable: false });
    Object.defineProperty(rows, "actualAdjustment", { value: actualAdjustment, enumerable: false });
    return rows;
  };
  if (klt === "101") return thsFreeDailyHistory(security, { limit: wanted, fqt: adjustment, signal, now });
  if (klt === "102" || klt === "103") {
    const path = `${klt === "102" ? "1" : "2"}${adjustment}`;
    const rows = parseThsLineData((await readJsonp(`${base}/${path}/last.js`, LINE_POLICY, signal))?.data, unitsPerLot);
    if (!rows.length) throw thsFreeError("同花顺免费周/月线为空", "THS_FREE_EMPTY_HISTORY");
    rows.sort((left, right) => left.date.localeCompare(right.date));
    const label = adjustment === 1 ? "qfq" : adjustment === 2 ? "hfq" : "unadjusted";
    return tag(withDerivedFields(rows).slice(-wanted), `ths_free_${label}_${klt === "102" ? "week" : "month"}`, adjustment);
  }
  const period = MINUTE_PERIODS[klt];
  if (!period) throw thsFreeError(`不支持的K线周期：${interval}`, "THS_FREE_UNSUPPORTED");
  let rows = parseThsMinuteData((await readJsonp(`${base}/${period.path}/last.js`, LINE_POLICY, signal))?.data, unitsPerLot);
  if (!rows.length) throw thsFreeError("同花顺免费分钟线为空", "THS_FREE_EMPTY_HISTORY");
  rows.sort((left, right) => left.date.localeCompare(right.date));
  if (period.group) rows = groupMinuteRows(rows, period.group, period.sourceMinutes, now);
  // 分钟线不复权（同花顺分钟周期只有不复权）。
  return tag(withDerivedFields(rows).slice(-wanted), `ths_free_${klt}m`, 0);
}

/**
 * 同花顺分时（网页版分时图同一接口 v6/time/{市场}_{代码}/last.js，盘中实时）：
 * 返回 { date, preClose, rows }。每点格式为“时间,价格,成交额,均价,成交量”；
 * 成交额与成交量的位置、成交量单位（股/手）按数值自洽关系识别，不靠猜。
 * rows 统一为 1 分钟线形态（date=YYYY-MM-DD HH:MM，volume 为手，amount 为元），并带源端均价 average。
 */
function parseThsTimeShare(payload, unitsPerLot = 100) {
  const body = payload && typeof payload === "object" && typeof payload.data !== "string"
    ? Object.values(payload).find((value) => value && typeof value === "object" && typeof value.data === "string")
    : payload;
  if (!body || typeof body.data !== "string") return null;
  const date = String(body.date || "").replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
  const preClose = num(body.pre);
  const points = [];
  for (const line of body.data.split(";")) {
    const cells = line.split(",");
    if (cells.length < 5 || !/^\d{4}$/.test(cells[0])) continue;
    const price = num(cells[1]), a = num(cells[2]), average = num(cells[3]), b = num(cells[4]);
    if (!(price > 0)) continue;
    points.push({ time: `${cells[0].slice(0, 2)}:${cells[0].slice(2)}`, price, a, b, average });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !points.length) return null;
  // 识别：成交额/成交量 ≈ 价格（量为股/张）或 ≈ 价格×每手单位（量为手）。
  // 不能靠 sa >= sb 猜测方向（价格 < 1 元的 ETF/低价股成交额小于股数）；
  // 在两种列顺序 × 两种成交量单位共 4 个候选里选对数相对误差最小者。
  const sum = (key) => points.reduce((total, point) => total + (point[key] > 0 ? point[key] : 0), 0);
  const meanPrice = points.reduce((total, point) => total + point.price, 0) / points.length;
  const sa = sum("a"), sb = sum("b");
  const candidates = sa > 0 && sb > 0
    ? [
        { amountFirst: true, sharesPerVolumeUnit: 1, error: Math.abs(Math.log((sa / sb) / meanPrice)) },
        { amountFirst: true, sharesPerVolumeUnit: unitsPerLot, error: Math.abs(Math.log((sa / sb) / (meanPrice * unitsPerLot))) },
        { amountFirst: false, sharesPerVolumeUnit: 1, error: Math.abs(Math.log((sb / sa) / meanPrice)) },
        { amountFirst: false, sharesPerVolumeUnit: unitsPerLot, error: Math.abs(Math.log((sb / sa) / (meanPrice * unitsPerLot))) }
      ]
    : [{ amountFirst: true, sharesPerVolumeUnit: 1, error: 0 }];
  const best = candidates.reduce((acc, item) => (item.error < acc.error ? item : acc), candidates[0]);
  const { amountFirst, sharesPerVolumeUnit } = best;
  const rows = points.map((point) => {
    const amount = amountFirst ? point.a : point.b, volume = amountFirst ? point.b : point.a;
    return { date: `${date} ${point.time}`, open: point.price, high: point.price, low: point.price, close: point.price,
      volume: volume === null ? null : (volume * sharesPerVolumeUnit) / unitsPerLot, volumeUnit: "lots",
      amount, average: point.average > 0 ? point.average : null };
  });
  return { date, preClose: preClose > 0 ? preClose : null, rows };
}

/**
 * 开盘前（约 9:15–9:30）源端已经把日期换成当天，但分时点还是上一个交易日的完整一天。
 * 判断依据：日期是今天，而最后一个点的时间比现在还晚。此时把日期改回上一个交易日，避免把昨天的走势当成今天。
 * clock 为北京时间 { date, minute }；previousDate 为上一个交易日（未知时原样返回）。
 */
function rebaseStaleTimeShare(share, clock, previousDate) {
  const last = String(share?.rows?.at(-1)?.date || "").slice(11, 16);
  if (!share || share.date !== clock?.date || !/^\d{2}:\d{2}$/.test(last)) return share;
  const lastMinute = Number(last.slice(0, 2)) * 60 + Number(last.slice(3, 5));
  if (lastMinute <= clock.minute + 2 || !/^\d{4}-\d{2}-\d{2}$/.test(String(previousDate || ""))) return share;
  return { ...share, date: previousDate, rows: share.rows.map((row) => ({ ...row, date: `${previousDate}${String(row.date).slice(10)}` })) };
}

async function thsFreeTimeShare(security, { signal } = {}) {
  const target = resolveThsFreeSymbol(security);
  if (!target) throw thsFreeError("同花顺分时只覆盖A股个股与可转债", "THS_FREE_UNSUPPORTED");
  const url = `${THS_FREE_HOST}/v6/time/${target.market}_${target.code}/last.js`;
  const parsed = parseThsTimeShare(await readJsonp(url, LINE_POLICY, signal), lotSize(security));
  if (!parsed) throw thsFreeError("同花顺分时为空", "THS_FREE_EMPTY_HISTORY");
  return parsed;
}

/** 全市场基准：同花顺全A(沪深京)。中证全指 000985 在同花顺免费网关上没有。 */
const THS_ALL_A = Object.freeze({ code: "883957", name: "同花顺全A(沪深京)", thsMarket: "48", assetType: "index", secid: "", thscode: "883957.TI", marketName: "指数" });
const THS_HS300 = Object.freeze({ code: "1B0300", name: "沪深300", thsMarket: "hs", assetType: "index", secid: "", thscode: "000300.SH", marketName: "指数" });

module.exports = {
  THS_ALL_A,
  THS_HS300,
  thsFreeKline,
  thsFreeTimeShare,
  parseThsTimeShare,
  rebaseStaleTimeShare,
  parseThsMinuteData,
  groupMinuteRows,
  THS_FREE_HOST,
  MAX_TRADING_LAG_SECONDS,
  resolveThsFreeSymbol,
  thsFreeSupports,
  parseBeijingTime,
  isTradingStatus,
  normalizeThsFreeQuote,
  thsFreeQuote,
  thsFreeFiveRange,
  parseThsFiveRange,
  parseThsLineData,
  mergeQuoteIntoDailyRows,
  withDerivedFields,
  thsFreeDailyHistory
};
