"use strict";

/**
 * 同花顺**官方免费**行情网关。
 *
 * 来源：`d.10jqka.com.cn`（同花顺个股/指数页自身使用的行情接口，无需 token、无付费）。
 * 走的是 JSONP 包裹（`quotebridge_v6_xxx({...})`），User-Agent + Referer 即可访问。
 *
 * 三条链路（全部实测可用）：
 *   1. 实时快照  /v6/realhead/{market}_{code}/defer/last.js
 *   2. 日K线历史 /v6/line/{market}_{code}/01/last.js
 *   3. 板块成分  https://q.10jqka.com.cn/thshy/detail/code/{code}/（GBK 页面）
 *
 * market 前缀：个股 `hs_`（沪深），板块指数 `48_`（同花顺行业指数）。
 *
 * 关键字段编号（realhead items，同花顺内部约定）：
 *   10=现价 8=最高 9=最低 7=开盘 13=成交量(股) 19=成交额(元)
 *   24=均价 199112=涨跌幅(%) 264648=涨跌额(元) 15=外盘 14=内盘
 */

const { getHexinToken } = require("./ths-hexin-v.cjs");
const { fetchWithPolicy, fetchArrayBufferWithPolicy, readResponseBytesWithinLimit } = require("./http-client.cjs");
const { producerContext } = require("./service-context.cjs");

// A fast logical timeout/cancellation must not release ownership of a slower
// transport. The registry also covers sector-explorer calls outside a producer.
const pendingThsRequests = new Set();
function trackThsRequest(request) {
  const physical = Promise.resolve(request?.drained ?? request);
  pendingThsRequests.add(physical);
  const release = () => { pendingThsRequests.delete(physical); };
  physical.then(release, release);
  // Register an already-started promise, so a synchronous abort cannot skip it.
  producerContext.getStore()?.track(physical);
  return request;
}

async function drainThsQuoteRequests() {
  while (pendingThsRequests.size) await Promise.allSettled([...pendingThsRequests]);
}

// 同花顺页面/JSONP 的响应体上限：板块成分页与资金流页是整页 HTML（GBK），
// 实测远小于 1MB；4MB 足够且能挡住异常超大响应（与 http-client 同一上限逻辑）。
const THS_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

const THS_QUOTE_HOST = "https://d.10jqka.com.cn";
const THS_SECTOR_PAGE = "https://q.10jqka.com.cn/thshy";

async function readThsBytes(fetchImpl, url, headers, signal, errorLabel = "同花顺行情", track = factory => factory()) {
  // Keep built-in transport ownership inside its consuming policy callback.
  // A raw Response can error before its asynchronous source cancellation ends.
  if (fetchImpl === globalThis.fetch || fetchImpl === fetchWithPolicy) {
    return track(() => trackThsRequest(fetchArrayBufferWithPolicy(url, { headers, signal }, { maxResponseBytes: THS_MAX_RESPONSE_BYTES })));
  }
  const res = await trackThsRequest(track(() => fetchImpl(url, { headers, signal })));
  if (signal.aborted) {
    try { await res.body?.cancel(); } catch { /* Preserve cancellation. */ }
    signal.throwIfAborted();
  }
  if (!res.ok) throw Object.assign(new Error(`${errorLabel} HTTP ${res.status}: ${url}`), { code: "THS_HTTP", status: res.status });
  return readResponseBytesWithinLimit(res, THS_MAX_RESPONSE_BYTES);
}

function thsHeaders(referer) {
  return {
    "User-Agent":
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    Referer: referer,
    Accept: "*/*",
    "Accept-Language": "zh-CN,zh;q=0.9"
  };
}

/** 解 JSONP：`quotebridge_v6_line_x({...})` → 对象 */
function unwrapJsonp(text) {
  const trimmed = String(text || "").trim();
  const open = trimmed.indexOf("(");
  const close = trimmed.lastIndexOf(")");
  if (open < 0 || close <= open) throw new Error("同花顺行情响应不是有效的 JSONP");
  return JSON.parse(trimmed.slice(open + 1, close));
}

const num = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

/**
 * 解析带中文单位的数值：`4.50亿` → 450000000，`43.96亿` → 4396000000，
 * `1234万` → 12340000，`--` → null。
 * 同花顺成分表的「成交额 / 流通股 / 流通市值」都是这种格式，
 * 直接 Number() 会得到 NaN，从而把真实数据丢成 null。
 */
const numCn = (value) => {
  if (value === null || value === undefined) return null;
  const text = String(value).replace(/[,\s]/g, "").trim();
  if (!text || text === "--" || text === "-") return null;
  const match = text.match(/^(-?\d+(?:\.\d+)?)([万亿千百]?)/);
  if (!match) return null;
  const base = Number(match[1]);
  if (!Number.isFinite(base)) return null;
  const scale = { 万: 1e4, 亿: 1e8, 千: 1e3, 百: 1e2, "": 1 }[match[2]] || 1;
  return base * scale;
};

/**
 * 实时快照。
 * @param {{ code: string, market?: "hs" | "48" }} target
 */
function normalizeRealhead(items) {
  const pick = (key) => num(items?.[key]);
  const latest = pick("10");
  const preClose = pick("6");
  const high = pick("8");
  const low = pick("9");
  const open = pick("7");
  const volume = pick("13");
  const amount = pick("19");
  return {
    latest,
    open,
    high,
    low,
    preClose,
    volume,
    amount,
    averagePrice: pick("24"),
    // 字段编号经实测确认：199112 = 涨跌幅(%)，264648 = 涨跌额(元)。
    // （最初按猜测写反了，导致 +1.55% 被读成 -89.92 —— 已修正。）
    changePct: pick("199112"),
    change: pick("264648"),
    outerVolume: pick("15"),
    innerVolume: pick("14"),
    // 涨跌幅缺失时用现价/昨收推算，保持与其它 provider 口径一致
    changePctResolved:
      pick("199112") !== null
        ? pick("199112")
        : latest !== null && preClose !== null && preClose > 0
          ? (latest / preClose - 1) * 100
          : null
  };
}


/** 抓取文本（GBK 或 UTF-8 自适应） */
/**
 * 抓取文本（GBK 或 UTF-8 自适应）。
 *
 * **必须有超时**：同花顺是外部服务，网络抖动或反爬限流会让 fetch 长时间挂起。
 * 没有超时的话，板块页会一直转圈、用户只能强杀应用 —— 这是「随时能用」的底线要求。
 * 超时 + AbortController 双保险：即使底层 fetch 不响应 abort，我们也先返回错误。
 */
const DEFAULT_TIMEOUT_MS = 8000;

async function fetchThsText(fetchImpl, url, encoding, referer, timeoutMs = DEFAULT_TIMEOUT_MS, { signal: parentSignal } = {}) {
  parentSignal?.throwIfAborted();
  const controller = new AbortController();
  const signal = parentSignal ? AbortSignal.any([parentSignal, controller.signal]) : controller.signal;
  let timer, abort;
  const interrupted = new Promise((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    timer = setTimeout(() => {
      controller.abort(Object.assign(new Error(`同花顺行情超时（${timeoutMs}ms）: ${url}`), { code: "THS_TIMEOUT" }));
    }, timeoutMs);
  });
  try {
    const request = trackThsRequest((async () => {
      // 部分路径（v4/line/bk_*）要求 Cookie: v=<hexin-v>。
      // token 由同源 JS 现场计算，生成失败时降级为不带 token 的请求。
      const headers = thsHeaders(referer);
      const token = getHexinToken();
      if (token && /d\.10jqka\.com\.cn/.test(url)) {
        headers.Cookie = `v=${token}`;
      }
      const buffer = await readThsBytes(fetchImpl, url, headers, signal);
      signal.throwIfAborted();
      return new TextDecoder(encoding || "utf-8").decode(buffer);
    })());
    return await Promise.race([request, interrupted]);
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
  }
}

/** 板块实时快照（同花顺行业指数，market 前缀 48） */
async function fetchThsSectorSnapshot(fetchImpl, code, { signal } = {}) {
  const url = `${THS_QUOTE_HOST}/v6/realhead/48_${code}/last.js`;
  const payload = unwrapJsonp(await fetchThsText(fetchImpl, url, "utf-8", `${THS_SECTOR_PAGE}/`, 6000, { signal }));
  return normalizeRealhead(payload?.items);
}

/** 个股实时快照（market 前缀 hs） */
async function fetchThsStockSnapshot(fetchImpl, code, { signal } = {}) {
  const url = `${THS_QUOTE_HOST}/v6/realhead/hs_${code}/last.js`;
  const payload = unwrapJsonp(await fetchThsText(fetchImpl, url, "utf-8", "https://stockpage.10jqka.com.cn/", 6000, { signal }));
  return normalizeRealhead(payload?.items);
}

/**
 * 板块/个股日K线历史。
 * 返回 [{ date, open, high, low, close, volume, amount }]，按日期升序。
 * 实测板块指数可回溯 4600+ 根（2007 年至今）。
 */
async function fetchThsDailyHistory(fetchImpl, code, { market = "48", limit = 160, signal } = {}) {
  const prefix = market === "48" ? "48" : "hs";
  const url = `${THS_QUOTE_HOST}/v6/line/${prefix}_${code}/01/last.js`;
  const payload = unwrapJsonp(await fetchThsText(fetchImpl, url, "utf-8", `${THS_SECTOR_PAGE}/`, 8000, { signal }));
  const raw = String(payload?.data || "");
  if (!raw) throw new Error("同花顺K线响应为空");
  const rows = [];
  for (const line of raw.split(";")) {
    const cells = line.split(",");
    if (cells.length < 7) continue;
    const date = cells[0];
    if (!/^\d{8}$/.test(date)) continue;
    const row = {
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      open: num(cells[1]),
      high: num(cells[2]),
      low: num(cells[3]),
      close: num(cells[4]),
      volume: num(cells[5]),
      amount: num(cells[6])
    };
    if ([row.open, row.high, row.low, row.close].some((v) => v === null)) continue;
    rows.push(row);
  }
  if (!rows.length) throw new Error("同花顺K线未解析出有效行");
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return limit > 0 ? rows.slice(-limit) : rows;
}

/** 解析板块成分表（GBK 页面） */
function parseThsSectorMembers(html) {
  const table = String(html).match(/<table[^>]*m-pager-table[^>]*>([\s\S]*?)<\/table>/i);
  if (!table) return [];
  const out = [];
  for (const m of table[1].matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const row = m[1];
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((c) =>
      c[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim()
    );
    if (cells.length < 6) continue;
    if (!/^\d+$/.test(cells[0])) continue;
    const code = cells[1];
    if (!/^\d{6}$/.test(code)) continue;
    // 同花顺板块成分页共 14 列：
    // 序号 代码 名称 现价 涨跌幅 涨跌 涨速 换手 量比 振幅 成交额 流通股 流通市值 市盈率
    out.push({
      code,
      name: cells[2],
      latest: num(cells[3]),
      changePct: num(cells[4]),
      change: num(cells[5]),
      speedPct: num(cells[6]),
      turnover: num(cells[7]),
      volumeRatio: num(cells[8]),
      amplitude: num(cells[9]),
      amount: numCn(cells[10]),
      floatShares: numCn(cells[11]),
      floatMarketCap: numCn(cells[12]),
      peRatio: num(cells[13])
    });
  }
  return out;
}

/** 抓取板块成分股（逐只明细，非聚合） */
async function fetchThsSectorMembers(fetchImpl, target, { maxPages = 20, signal } = {}) {
  signal?.throwIfAborted();
  // The historical string argument is an industry page code. Concepts must
  // explicitly supply their directory cid; their platecode belongs to index APIs.
  const identity = target && typeof target === "object" ? target : { kind: "industry", code: target };
  const kind = identity.kind || "industry";
  const code = String(kind === "concept" ? identity.cid || "" : identity.code || "");
  if (!["industry", "concept"].includes(kind) || !/^\d{6}$/.test(code)) {
    throw new TypeError("同花顺板块成分需要明确的行业代码或概念 cid");
  }
  const pageBase = kind === "concept" ? THS_CONCEPT_PAGE : THS_SECTOR_PAGE;
  // 成分页每页 20 只。翻页必须用「普通页面路径」：
  //   /thshy/detail/code/{code}/page/N/
  // 带 /ajax/1/ 的路径需要反爬令牌（实测 401）。
  const seen = new Set();
  const all = [];
  // 注意：未登录状态下只能翻到第 5 页（第 6 页起 302 跳登录页），
  // 因此最多拿到 100 只成分 —— 这是同花顺的匿名访问上限，不是代码 bug。
  // 广度请用榜单页的官方「上涨/下跌家数」，不要用这 100 只反推。
  for (let page = 1; page <= maxPages; page += 1) {
    signal?.throwIfAborted();
    const url = page === 1
      ? `${pageBase}/detail/code/${code}/`
      : `${pageBase}/detail/code/${code}/page/${page}/`;
    let html;
    try {
      html = await fetchThsText(fetchImpl, url, "gb18030", `${pageBase}/`, DEFAULT_TIMEOUT_MS, { signal });
    } catch {
      signal?.throwIfAborted();
      break; // 302→登录页 / 网络异常：停止翻页，保留已取到的部分
    }
    const rows = parseThsSectorMembers(html);
    if (!rows.length) break;
    let added = 0;
    for (const row of rows) {
      if (seen.has(row.code)) continue;
      seen.add(row.code);
      all.push(row);
      added += 1;
    }
    if (added === 0) break;
  }
  if (!all.length) throw new Error("同花顺板块成分页未解析到成分股");
  return all;
}



/**
 * 概念板块（/gn/）。
 *
 * 与行业板块的**关键区别**（实测踩过的坑）：
 *   · 行业板块代码 881xxx 直接就是指数代码
 *   · 概念板块页面代码 cid（300xxx~309xxx）**不是**指数代码，
 *     真正的指数代码是 platecode（885333~886113），两者是多对一映射
 *   · 用 cid 去查 d.10jqka.com.cn 会 404，必须用 platecode
 *
 * 数据来源：/gn/ 页面内嵌的 `id="gnSection"` JSON，一次返回全部概念，
 * 且自带行情：199112=涨跌幅(%)、zjjlr=净流入(亿)、zfl=涨幅贡献。
 */
const THS_CONCEPT_PAGE = "https://q.10jqka.com.cn/gn";

function parseThsConceptSection(html) {
  const match = String(html).match(/id="gnSection"\s+value='(\{[\s\S]*?\})'/);
  if (!match) return [];
  let data;
  try {
    data = JSON.parse(match[1]);
  } catch {
    return [];
  }
  const out = [];
  for (const item of Object.values(data || {})) {
    const platecode = String(item?.platecode || "");
    const name = String(item?.platename || "").trim();
    if (!/^\d{6}$/.test(platecode) || !name) continue;
    out.push({
      platecode,
      cid: String(item?.cid || ""),
      name,
      changePct: num(item?.["199112"]),
      netInflow: num(item?.zjjlr),
      contribution: num(item?.zfl)
    });
  }
  // 按涨幅降序（与研究口径一致），缺失排最后
  out.sort((a, b) => {
    if (a.changePct === null && b.changePct === null) return a.name.localeCompare(b.name, "zh");
    if (a.changePct === null) return 1;
    if (b.changePct === null) return -1;
    return b.changePct - a.changePct;
  });
  return out;
}

/** 抓取全部概念板块（约 293 个，含涨跌幅/净流入） */
async function fetchThsConceptBoard(fetchImpl, timeoutMs = 8000, { signal } = {}) {
  const html = await fetchThsText(fetchImpl, `${THS_CONCEPT_PAGE}/`, "gb18030", `${THS_CONCEPT_PAGE}/`, timeoutMs, { signal });
  const rows = parseThsConceptSection(html);
  if (!rows.length) throw new Error("同花顺概念板块页未解析到 gnSection 数据");
  return rows;
}

/** 按概念名或指数代码匹配一个概念板块 */
async function findThsConcept(fetchImpl, needle, { signal } = {}) {
  const rows = await fetchThsConceptBoard(fetchImpl, DEFAULT_TIMEOUT_MS, { signal });
  const key = String(needle || "").trim();
  if (!key) return null;
  return rows.find((r) => r.platecode === key)
    || rows.find((r) => r.name === key)
    || rows.find((r) => r.name.includes(key) || key.includes(r.name))
    || null;
}


/**
 * 同花顺 v4 按年历史 K 线（`v4/line/bk_{code}/01/{year}.js`）。
 *
 * 与 `v6/line/.../last.js` 的区别：
 *   · v6 只给「最近 N 根」，v4 可以精确取某一整年
 *   · v4 需要 `Cookie: v=<hexin-v>`，v6 不需要
 * 好处是可以按年回溯很久（实测 2024~2026 三年共 674 根），
 * 用于计算 1/3/5 日超额与更长周期的延续性指标。
 */
async function fetchThsYearlyHistory(fetchImpl, code, year, { market = "bk", signal } = {}) {
  const prefix = market === "bk" ? "bk" : market;
  const url = `${THS_QUOTE_HOST}/v4/line/${prefix}_${code}/01/${year}.js`;
  const text = await fetchThsText(fetchImpl, url, "utf-8", "http://q.10jqka.com.cn", 8000, { signal });
  const payload = unwrapJsonp(text);
  const raw = String(payload?.data || "");
  if (!raw) return [];
  const rows = [];
  for (const line of raw.split(";")) {
    const cells = line.split(",");
    if (cells.length < 7) continue;
    const date = cells[0];
    if (!/^\d{8}$/.test(date)) continue;
    const row = {
      date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
      open: num(cells[1]), high: num(cells[2]), low: num(cells[3]), close: num(cells[4]),
      volume: num(cells[5]), amount: num(cells[6])
    };
    if ([row.open, row.high, row.low, row.close].some((v) => v === null)) continue;
    rows.push(row);
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

/** 取最近若干年的日线（默认 2 年，够算 1/3/5 日超额与 20 日均量） */
async function fetchThsMultiYearHistory(fetchImpl, code, { years = 2, market = "bk", signal } = {}) {
  signal?.throwIfAborted();
  const current = new Date();
  const startYear = current.getUTCFullYear() - years + 1;
  const all = [];
  const seen = new Set();
  for (let year = startYear; year <= current.getUTCFullYear(); year += 1) {
    signal?.throwIfAborted();
    try {
      const rows = await fetchThsYearlyHistory(fetchImpl, code, year, { market, signal });
      for (const row of rows) {
        if (seen.has(row.date)) continue;
        seen.add(row.date);
        all.push(row);
      }
    } catch {
      signal?.throwIfAborted();
      // 某一年取不到不影响其它年份
    }
  }
  all.sort((a, b) => a.date.localeCompare(b.date));
  return all;
}


/**
 * 同花顺数据中心 `data.10jqka.com.cn` 的**板块资金流**。
 *
 * 这是之前完全缺失的一块：板块页的实时榜只给涨跌幅/涨跌家数，
 * 拿不到「主力净流入」。而数据中心这条链路用同一个 hexin-v token 就能通。
 *
 * 实测（2026-10-20）：
 *   funds/hyzjl  行业资金流  51 行/页，共 2 页
 *   funds/gnzjl  概念资金流  51 行/页
 * 字段：序号 | 行业 | 行业指数 | 涨跌幅 | 流入资金(亿) | 流出资金(亿) | 净额(亿) | 公司家数 | 领涨股 | 涨跌幅 | 当前价
 *
 * 注意：该接口返回 **GBK** 编码，必须用 gb18030 解码，否则中文全是乱码。
 */
const THS_DATA_HOST = "https://data.10jqka.com.cn";

const THS_FUND_KIND = {
  industry: "hyzjl",
  concept: "gnzjl"
};

function parseThsFundFlowTable(html) {
  const out = [];
  const rows = [...String(html).matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1]);
  for (const row of rows) {
    const cells = [...row.matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)]
      .map((m) => m[1].replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim());
    if (cells.length < 8) continue;
    if (!/^\d+$/.test(cells[0])) continue;
    const numCnLoose = (v) => {
      const t = String(v).replace(/[%,]/g, "").trim();
      if (!t || t === "--" || t === "-") return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };
    // 资金流页的板块名是一个 <a href=".../thshy/detail/code/881270/"> 链接，
    // 顺手把 6 位板块代码抽出来 —— 后续取成分股/指数行情都要用它。
    const codeMatch = row.match(/thshy\/detail\/code\/(\d{6})/);
    out.push({
      code: codeMatch ? codeMatch[1] : "",
      name: cells[1],
      indexValue: num(cells[2]),
      changePct: numCnLoose(cells[3]),
      inflow: num(cells[4]),      // 亿
      outflow: num(cells[5]),     // 亿
      netInflow: num(cells[6]),   // 亿
      companyCount: num(cells[7]),
      leaderName: cells[8] || "",
      leaderChangePct: numCnLoose(cells[9]),
      leaderPrice: num(cells[10])
    });
  }
  return out;
}

/**
 * 抓取板块资金流（自动翻页）。
 * @param {"industry"|"concept"} kind
 */
async function fetchThsFundFlow(fetchImpl, kind = "industry", { maxPages = 3, timeoutMs = 8000, signal, track } = {}) {
  signal?.throwIfAborted();
  const slug = THS_FUND_KIND[kind] || THS_FUND_KIND.industry;
  const seen = new Set();
  const all = [];
  const token = getHexinToken();
  for (let page = 1; page <= maxPages; page += 1) {
    signal?.throwIfAborted();
    const url = `${THS_DATA_HOST}/funds/${slug}/field/tradezdf/order/desc/page/${page}/ajax/1/free/1/`;
    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/89.0.4389.90 Safari/537.36",
      Referer: `${THS_DATA_HOST}/funds/${slug}/`,
      Accept: "*/*"
    };
    if (token) {
      headers.Cookie = `v=${token}`;
      headers["hexin-v"] = token;
    }
    const controller = new AbortController();
    const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let html;
    try {
      html = await trackThsRequest((async () => {
        // 该接口是 GBK
        const text = new TextDecoder("gb18030").decode(await readThsBytes(fetchImpl, url, headers, requestSignal, "资金流", track));
        requestSignal.throwIfAborted();
        return text;
      })());
    } finally {
      clearTimeout(timer);
    }
    const rows = parseThsFundFlowTable(html);
    if (!rows.length) break;
    let added = 0;
    for (const row of rows) {
      if (seen.has(row.name)) continue;
      seen.add(row.name);
      all.push(row);
      added += 1;
    }
    if (added === 0) break;
  }
  return all;
}

module.exports = {
  drainThsQuoteRequests,
  THS_MAX_RESPONSE_BYTES,
  numCn,
  DEFAULT_TIMEOUT_MS,
  THS_QUOTE_HOST,
  THS_SECTOR_PAGE,
  thsHeaders,
  unwrapJsonp,
  normalizeRealhead,
  num,
  fetchThsSectorSnapshot,
  fetchThsStockSnapshot,
  fetchThsDailyHistory,
  fetchThsSectorMembers,
  parseThsSectorMembers,
  parseThsConceptSection,
  fetchThsConceptBoard,
  findThsConcept,
  fetchThsText,
  fetchThsYearlyHistory,
  fetchThsMultiYearHistory,
  fetchThsFundFlow,
  parseThsFundFlowTable
};
