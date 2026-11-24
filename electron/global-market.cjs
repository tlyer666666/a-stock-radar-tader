"use strict";

/**
 * 全球市场与外围资讯（AI 问股「global_markets / global_news」工具的数据来源）。
 *
 * - 行情：东方财富全球指数批量接口，一次取隔夜美股、亚太、欧洲、A50 期指、美股期货、汇率、美元指数、
 *   美债收益率与商品；每条带接口时间戳，便于判断是隔夜收盘还是盘中。
 * - 资讯：东方财富 7×24 与财联社电报，按关键词挑出外围市场、海外央行与宏观、外媒与机构观点、大宗商品四类。
 *   彭博、路透等外媒原文多为付费内容，这里只能收录国内快讯对其报道的转述，标题里会写明来源。
 *
 * 所有网络请求由调用方注入的 fetchJson 完成（复用 http-client 的超时、字节上限和熔断）。
 * 缺失的数字保持 null，绝不当成 0。
 */

const EAST_ULIST = "https://push2.eastmoney.com/api/qt/ulist.np/get";
const FAST_NEWS_URL = "https://np-weblist.eastmoney.com/comm/web/getFastNewsList";
const CLS_TELEGRAPH_URL = "https://www.cls.cn/api/cache";
const QUOTE_CACHE_MS = 60_000;
const NEWS_CACHE_MS = 120_000;

/** 分组与证券代码（secid）。顺序就是展示与喂给模型的顺序。 */
const GLOBAL_INSTRUMENTS = Object.freeze([
  { group: "美股", secid: "100.DJIA", name: "道琼斯" },
  { group: "美股", secid: "100.SPX", name: "标普500" },
  { group: "美股", secid: "100.NDX", name: "纳斯达克" },
  { group: "美股", secid: "107.KWEB", name: "中概互联网ETF(KWEB)" },
  { group: "美股期货", secid: "103.ES00Y", name: "标普期货" },
  { group: "美股期货", secid: "103.NQ00Y", name: "纳指期货" },
  { group: "亚太", secid: "100.N225", name: "日经225" },
  { group: "亚太", secid: "100.KS11", name: "韩国KOSPI" },
  { group: "亚太", secid: "100.HSI", name: "恒生指数" },
  { group: "亚太", secid: "124.HSTECH", name: "恒生科技" },
  { group: "亚太", secid: "100.TWII", name: "台湾加权" },
  { group: "亚太", secid: "100.STI", name: "新加坡海峡时报" },
  { group: "亚太", secid: "100.SENSEX", name: "印度SENSEX" },
  { group: "欧洲", secid: "100.GDAXI", name: "德国DAX" },
  { group: "欧洲", secid: "100.FTSE", name: "英国富时100" },
  { group: "欧洲", secid: "100.FCHI", name: "法国CAC40" },
  { group: "A50", secid: "104.CN00Y", name: "富时A50期指" },
  { group: "汇率利率", secid: "133.USDCNH", name: "美元兑离岸人民币" },
  { group: "汇率利率", secid: "100.UDI", name: "美元指数" },
  { group: "汇率利率", secid: "171.US10Y", name: "美国10年期国债收益率" },
  { group: "商品", secid: "101.GC00Y", name: "COMEX黄金" },
  { group: "商品", secid: "101.SI00Y", name: "COMEX白银" },
  { group: "商品", secid: "102.CL00Y", name: "NYMEX原油" }
]);

const num = value => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() && value !== "-" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};

/** 接口时间戳（秒）→ 北京时间 "MM-DD HH:mm"。 */
function shanghaiStamp(seconds) {
  const s = num(seconds);
  if (s === null || s <= 0) return "";
  return new Date(s * 1000 + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ");
}

function normalizeQuote(raw, instrument) {
  const rawLatest = num(raw?.f2);
  const latest = rawLatest !== null && rawLatest > 0 ? rawLatest : null;
  const changePct = num(raw?.f3);
  return {
    group: instrument.group,
    name: instrument.name,
    code: String(raw?.f12 || instrument.secid.split(".")[1]),
    latest,
    changePct,
    change: num(raw?.f4),
    open: num(raw?.f17),
    preClose: num(raw?.f18),
    time: shanghaiStamp(raw?.f124)
  };
}

const signedPct = value => value === null ? "--" : `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;

/** 一句话概括外围：美股、亚太、A50、人民币各给一个方向。 */
function summarizeGlobal(quotes) {
  const pick = name => quotes.find(item => item.name === name);
  const parts = [];
  const us = ["道琼斯", "标普500", "纳斯达克"].map(pick).filter(item => item && item.changePct !== null);
  if (us.length) parts.push(`美股 ${us.map(item => `${item.name}${signedPct(item.changePct)}`).join("、")}`);
  const asia = ["日经225", "韩国KOSPI", "恒生指数"].map(pick).filter(item => item && item.changePct !== null);
  if (asia.length) parts.push(`亚太 ${asia.map(item => `${item.name}${signedPct(item.changePct)}`).join("、")}`);
  const a50 = pick("富时A50期指");
  if (a50?.changePct !== null && a50) parts.push(`A50期指${signedPct(a50.changePct)}`);
  const cnh = pick("美元兑离岸人民币");
  if (cnh?.latest !== null && cnh) parts.push(`离岸人民币 ${cnh.latest}（${cnh.changePct !== null && cnh.changePct > 0 ? "人民币走弱" : cnh.changePct !== null && cnh.changePct < 0 ? "人民币走强" : "持平"}）`);
  return parts.join("；");
}

/** 资讯分类关键词。命中多个类别时取第一个。 */
const NEWS_CATEGORIES = Object.freeze([
  { id: "foreignView", label: "外媒与机构观点", re: /彭博|路透|华尔街日报|金融时报|日经新闻|CNBC|高盛|摩根士丹利|大摩|摩根大通|小摩|瑞银|花旗|野村|汇丰|贝莱德|桥水|外资|北向|海外机构|国际投行|全球基金/ },
  { id: "overseasMarket", label: "外围市场", re: /美股|道指|道琼斯|纳指|纳斯达克|标普|中概股|日经|东证|韩国|KOSPI|韩股|恒指|恒生|港股|台股|欧股|欧洲股市|德国DAX|富时|A50|美股期货/ },
  { id: "macroPolicy", label: "海外央行与宏观", re: /美联储|鲍威尔|降息|加息|非农|CPI|PCE|美债|收益率|日本央行|日银|欧洲央行|英国央行|美元指数|离岸人民币|人民币汇率|日元|韩元|关税|贸易谈判|地缘/ },
  { id: "commodity", label: "大宗商品", re: /原油|布伦特|WTI|黄金|白银|铜价|伦铜|天然气|OPEC/ }
]);
/** A 股研判：标题或正文同时提到 A股/大盘 与机构、外媒或券商的看法。 */
const A_SHARE_VIEW_RE = /(A股|大盘|沪指|上证|中国股市|中国股票|中国资产|人民币资产).{0,40}(看好|看多|看空|展望|研判|策略|配置|低估|高估|上调|下调|目标位|预计|认为|风险偏好|修复|机会|乐观|谨慎|风险回报)|(看好|看多|看空|展望|研判|策略|上调|下调|风险偏好|修复|乐观|谨慎|风险回报).{0,40}(A股|中国股市|中国股票|中国资产)/;

function newsCategory(text) {
  for (const category of NEWS_CATEGORIES) if (category.re.test(text)) return category;
  return null;
}

function normalizeFast(item) {
  const title = String(item?.title || "").trim();
  const summary = String(item?.summary || "").replace(/^【[^】]+】/, "").trim();
  const published = String(item?.showTime || "");
  const ms = Date.parse(published.replace(" ", "T") + "+08:00");
  return { title, summary, publishedAt: Number.isFinite(ms) ? new Date(ms).toISOString() : "", source: "东方财富7×24", id: `fast:${item?.code || title}` };
}

function normalizeCls(item) {
  const brief = String(item?.brief || item?.content || "");
  const title = String(item?.title || brief.replace(/^【([^】]+)】.*$/s, "$1").slice(0, 80)).trim();
  const summary = String(item?.content || brief).replace(/^【[^】]+】/, "").trim();
  const ctime = num(item?.ctime);
  return { title, summary, publishedAt: ctime ? new Date(ctime * 1000).toISOString() : "", source: "财联社电报", id: `cls:${item?.id || title}` };
}

const normTitle = value => String(value || "").replace(/[\s【】「」“”"'，,。.!！？?：:]/g, "").slice(0, 40);

/**
 * 从快讯里挑出外围相关条目并分类。纯函数，便于测试。
 * @param {Array<{title:string, summary:string, publishedAt:string, source:string}>} items
 * @param {{ nowMs?: number, hours?: number, limit?: number }} options
 */
function selectGlobalNews(items, { nowMs = Date.now(), hours = 18, limit = 30 } = {}) {
  const since = nowMs - Math.max(1, hours) * 3600_000;
  const seen = new Set();
  const picked = [];
  for (const item of Array.isArray(items) ? items : []) {
    const ms = Date.parse(item?.publishedAt || "");
    if (!Number.isFinite(ms) || ms < since || ms > nowMs + 5 * 60_000) continue;
    const text = `${item.title || ""} ${item.summary || ""}`;
    const category = A_SHARE_VIEW_RE.test(text) && /彭博|路透|高盛|摩根|瑞银|花旗|野村|外资|中金|中信|华泰|国泰君安|招商证券|广发|兴业|申万|海通|券商|机构|基金|研报/.test(text)
      ? { id: "aShareView", label: "对A股的研判" }
      : newsCategory(text);
    if (!category) continue;
    const key = normTitle(item.title || item.summary);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    picked.push({ ...item, category: category.id, categoryLabel: category.label, ms });
  }
  picked.sort((left, right) => right.ms - left.ms);
  const limited = picked.slice(0, Math.max(1, limit));
  const byCategory = {};
  for (const item of limited) byCategory[item.category] = (byCategory[item.category] || 0) + 1;
  return {
    items: limited.map(({ ms, ...rest }) => ({ ...rest, time: new Date(ms + 8 * 3600_000).toISOString().slice(5, 16).replace("T", " ") })),
    byCategory,
    windowHours: Math.max(1, hours)
  };
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

function createGlobalMarket({ fetchJson, now = () => Date.now() } = {}) {
  if (typeof fetchJson !== "function") throw new TypeError("fetchJson is required");
  let quoteCache = null;
  let quotePending = null;
  let quoteGeneration = 0;
  let newsCache = null;
  let newsPending = null;
  let newsGeneration = 0;

  async function fetchQuotes(signal) {
    const url = `${EAST_ULIST}?fltt=2&invt=2&fields=f2,f3,f4,f12,f13,f14,f17,f18,f124&secids=${GLOBAL_INSTRUMENTS.map(item => item.secid).join(",")}`;
    const json = await fetchJson(url, { signal, headers: { Referer: "https://quote.eastmoney.com/" } }, 10000);
    const rows = Array.isArray(json?.data?.diff) ? json.data.diff : [];
    const bySecid = new Map(rows.map(row => [`${row?.f13}.${row?.f12}`, row]));
    const quotes = GLOBAL_INSTRUMENTS.map(instrument => {
      const row = bySecid.get(instrument.secid);
      return row ? normalizeQuote(row, instrument) : { group: instrument.group, name: instrument.name, code: instrument.secid.split(".")[1], latest: null, changePct: null, change: null, open: null, preClose: null, time: "" };
    });
    const missing = quotes.filter(item => item.latest === null).map(item => item.name);
    return {
      fetchedAt: new Date(now()).toISOString(),
      summary: summarizeGlobal(quotes),
      quotes,
      ...(missing.length ? { missing } : {}),
      note: "美股、欧股为最近一个交易日收盘或盘中价；亚太在北京时间上午为当日盘中。time 是接口给出的最近成交时间（北京时间）。"
    };
  }

  async function loadMarkets({ forceRefresh = false, signal } = {}) {
    signal?.throwIfAborted?.();
    if (!forceRefresh && quoteCache && quoteCache.expiresAt > now()) return quoteCache.value;
    if (!forceRefresh && quotePending) return waitWithSignal(quotePending, signal);
    const generation = ++quoteGeneration;
    const flight = fetchQuotes().then(value => {
      if (generation === quoteGeneration && value.quotes.some(item => item.latest !== null)) {
        quoteCache = { value, expiresAt: now() + QUOTE_CACHE_MS };
      }
      return value;
    }).finally(() => {
      if (quotePending === flight) quotePending = null;
    });
    quotePending = flight;
    return waitWithSignal(flight, signal);
  }

  async function fetchNewsRaw(signal) {
    const fast = async (sortEnd = "") => {
      const url = `${FAST_NEWS_URL}?client=web&biz=web_724&fastColumn=102&sortEnd=${encodeURIComponent(sortEnd)}&pageSize=200&req_trace=${now()}`;
      const json = await fetchJson(url, { signal, headers: { Referer: "https://kuaixun.eastmoney.com/" } }, 8000);
      const rows = Array.isArray(json?.data?.fastNewsList) ? json.data.fastNewsList : [];
      return { rows: rows.map(normalizeFast), sortEnd: String(json?.data?.sortEnd || "") };
    };
    const cls = async () => {
      const url = `${CLS_TELEGRAPH_URL}?rn=100&lastTime=${Math.floor(now() / 1000)}&name=telegraph`;
      const json = await fetchJson(url, { signal, headers: { Referer: "https://www.cls.cn/telegraph" } }, 8000);
      return Array.isArray(json?.data?.roll_data) ? json.data.roll_data.map(normalizeCls) : [];
    };
    const [firstFast, clsRows] = await Promise.allSettled([fast(), cls()]);
    signal?.throwIfAborted?.();
    const items = [];
    const failed = [];
    if (firstFast.status === "fulfilled") {
      items.push(...firstFast.value.rows);
      // 第二页把时间窗口往前延到隔夜：美股收盘（北京时间早上 4–5 点）前后的快讯也能收到。
      if (firstFast.value.sortEnd) {
        try {
          items.push(...(await fast(firstFast.value.sortEnd)).rows);
        } catch (error) {
          signal?.throwIfAborted?.();
          if (error?.name === "AbortError") throw error;
          failed.push("东方财富7×24（第二页）");
        }
      }
    } else {
      if (firstFast.reason?.name === "AbortError") throw firstFast.reason;
      failed.push("东方财富7×24");
    }
    if (clsRows.status === "fulfilled") items.push(...clsRows.value);
    else {
      if (clsRows.reason?.name === "AbortError") throw clsRows.reason;
      failed.push("财联社电报");
    }
    signal?.throwIfAborted?.();
    if (!items.length) throw new Error("外围资讯暂时没取到（东方财富 7×24 与财联社电报均失败）");
    return { items, failed };
  }

  async function loadNews({ forceRefresh = false, signal, hours = 18, limit = 30 } = {}) {
    signal?.throwIfAborted?.();
    let raw;
    if (!forceRefresh && newsCache && newsCache.expiresAt > now()) raw = newsCache.value;
    else if (!forceRefresh && newsPending) raw = await waitWithSignal(newsPending, signal);
    else {
      const generation = ++newsGeneration;
      const flight = fetchNewsRaw().then(value => {
        if (generation === newsGeneration) newsCache = { value, expiresAt: now() + NEWS_CACHE_MS };
        return value;
      }).finally(() => {
        if (newsPending === flight) newsPending = null;
      });
      newsPending = flight;
      raw = await waitWithSignal(flight, signal);
    }
    const selected = selectGlobalNews(raw.items, { nowMs: now(), hours, limit });
    return {
      fetchedAt: new Date(now()).toISOString(),
      ...selected,
      sources: ["东方财富7×24", "财联社电报"],
      ...(raw.failed.length ? { failedSources: raw.failed } : {}),
      note: "彭博、路透、华尔街日报等外媒原文多为付费内容，这里只收录国内快讯对其报道的转述；没有出现的外媒观点不代表没有。"
    };
  }

  return { loadMarkets, loadNews };
}

module.exports = { createGlobalMarket, selectGlobalNews, summarizeGlobal, normalizeQuote, GLOBAL_INSTRUMENTS, NEWS_CATEGORIES };
