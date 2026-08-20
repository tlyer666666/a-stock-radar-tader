const THS_BASE = "https://quantapi.51ifind.com/api/v1";
const FAST_NEWS_URL = "https://np-weblist.eastmoney.com/comm/web/getFastNewsList";
const ANNOUNCEMENT_URL = "https://np-anotice-stock.eastmoney.com/api/security/ann";
const CLS_TELEGRAPH_URL = "https://www.cls.cn/api/cache";
const { fetchJsonWithPolicy } = require("./http-client.cjs");
const {
  thsProviderError,
  withThsAccessToken
} = require("./ths-token-manager.cjs");

function emptySourceCache() {
  return {
    value: null,
    expiresAt: 0,
    fetchedAt: "",
    cachedAtMs: 0,
    key: "",
    promise: null,
    promiseKey: "",
    generation: 0
  };
}

const sourceCaches = {
  fast: emptySourceCache(),
  cls: emptySourceCache(),
  announcement: emptySourceCache(),
  ths: emptySourceCache()
};
const NEWS_SOURCE_MAX_STALE_MS = Object.freeze({
  fast: 2 * 60 * 1000,
  cls: 2 * 60 * 1000,
  announcement: 30 * 60 * 1000,
  ths: 30 * 60 * 1000
});
const firstSeen = new Map();

const SECTOR_TERMS = {
  CPO: ["cpo", "光模块", "光通信", "800g", "1.6t", "硅光"],
  算力: ["算力", "智算", "数据中心", "服务器", "gpu", "ai芯片", "超节点"],
  机器人: ["机器人", "具身智能", "减速器", "灵巧手", "人形"],
  半导体: ["半导体", "芯片", "晶圆", "光刻", "存储"],
  液冷: ["液冷", "冷却液", "散热", "cdu"],
  脑机接口: ["脑机接口", "神经接口", "意图解码"],
  低空经济: ["低空经济", "无人机", "eVTOL", "通航"],
  新能源车: ["新能源汽车", "新能源车", "智能驾驶", "自动驾驶"],
  电池: ["电池", "锂电", "固态电池", "储能"],
  军工: ["军工", "航天", "航空发动机", "卫星"],
  医药: ["创新药", "医药", "医疗器械", "临床试验"],
  消费电子: ["消费电子", "手机", "折叠屏", "可穿戴"],
  并购重组: ["并购", "重组", "收购", "资产注入"]
};

const POSITIVE_TERMS = [
  "中标", "订单", "预增", "增持", "回购", "获批", "签订", "突破", "扩产",
  "涨价", "扭亏", "合作", "投产", "超预期", "创新高", "首次覆盖"
];
const NEGATIVE_TERMS = [
  "减持", "问询", "立案", "处罚", "亏损", "风险提示", "终止", "下修",
  "退市", "违规", "冻结", "诉讼", "暴跌", "澄清", "不及预期"
];
const MATERIAL_TERMS = [
  "业绩", "中标", "订单", "并购", "重组", "回购", "增持", "减持", "立案",
  "处罚", "政策", "国务院", "证监会", "工信部", "发改委", "获批", "涨价"
];

async function fetchJson(url, options = {}, timeoutMs = 12000) {
  const method = String(options?.method || "GET").toUpperCase();
  return fetchJsonWithPolicy(url, options, {
    timeoutMs,
    retries: method === "GET" || method === "HEAD" ? 1 : 0,
    minimumGapMs: /eastmoney\.com/i.test(String(url)) ? 160 : 80,
    headers: {
      "User-Agent": "Mozilla/5.0 AStockRadar/0.9"
    }
  });
}

function normalizeTitle(value = "") {
  return String(value)
    .replace(/[【】\[\]（）()：:\s]/g, "")
    .replace(/关于|公告|股份有限公司/g, "")
    .toLowerCase();
}

function parseTime(value) {
  const normalized = String(value || "").replace(/:(\d{3})$/, ".$1");
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function ageMinutes(value) {
  return Math.max(0, Math.round((Date.now() - parseTime(value).getTime()) / 60000));
}

function matchTerms(text, terms) {
  const normalized = String(text || "").toLowerCase();
  return terms.filter((term) => normalized.includes(term.toLowerCase()));
}

function relatedSectorsFor(text, stockList = []) {
  const sectors = [];
  for (const [sector, terms] of Object.entries(SECTOR_TERMS)) {
    if (matchTerms(text, terms).length) sectors.push(sector);
  }
  for (const code of stockList) {
    if (String(code).startsWith("90.BK")) sectors.push(String(code).slice(3));
  }
  return [...new Set(sectors)];
}

function classifyEvent(title, summary, sourceLevel) {
  const text = `${title} ${summary}`;
  const positiveHits = matchTerms(text, POSITIVE_TERMS);
  const negativeHits = matchTerms(text, NEGATIVE_TERMS);
  const materialHits = matchTerms(text, MATERIAL_TERMS);
  const direction =
    positiveHits.length && negativeHits.length ? "mixed" :
      negativeHits.length ? "negative" :
        positiveHits.length ? "positive" : "neutral";
  const riskSeverity =
    negativeHits.some((term) => ["立案", "处罚", "退市", "违规", "冻结"].includes(term)) ? 3 :
      negativeHits.length >= 2 ? 2 :
        negativeHits.length ? 1 : 0;
  const importanceScore = Math.max(
    20,
    Math.min(100, 38 + materialHits.length * 12 + Math.max(positiveHits.length, negativeHits.length) * 8)
  );
  const credibilityScore = sourceLevel === "A" ? 96 : sourceLevel === "B" ? 76 : 55;
  return {
    direction,
    riskSeverity,
    importanceScore,
    credibilityScore,
    reasons: [
      materialHits.length ? `命中重要事件：${materialHits.slice(0, 3).join("、")}` : "未命中重大事件词",
      positiveHits.length ? `正向词：${positiveHits.slice(0, 3).join("、")}` : "",
      negativeHits.length ? `风险词：${negativeHits.slice(0, 3).join("、")}` : ""
    ].filter(Boolean)
  };
}

function eventTypeFor(text, sourceType) {
  if (sourceType === "announcement") {
    if (/业绩|预增|预亏|年报|季报/.test(text)) return "业绩";
    if (/回购|增持|减持|权益变动/.test(text)) return "股东行为";
    if (/并购|重组|收购|资产/.test(text)) return "并购重组";
    if (/问询|立案|处罚|风险/.test(text)) return "监管风险";
    if (/中标|订单|合同/.test(text)) return "经营订单";
    return "公司公告";
  }
  if (/国务院|证监会|工信部|发改委|政策/.test(text)) return "政策";
  if (/涨|跌|指数|期货|汇率/.test(text)) return "市场";
  if (/产业|技术|产品|发布/.test(text)) return "产业";
  return "快讯";
}

function horizonFor(type) {
  if (["政策", "并购重组", "经营订单"].includes(type)) return "1–10日";
  if (["市场", "快讯"].includes(type)) return "盘中–1日";
  if (["业绩", "股东行为", "监管风险"].includes(type)) return "1–5日";
  return "1–3日";
}

function rememberFirstSeen(id) {
  if (!firstSeen.has(id)) firstSeen.set(id, new Date().toISOString());
  return firstSeen.get(id);
}

function normalizeFastNews(item) {
  const id = `east-fast-${item.code || item.realSort}`;
  const title = String(item.title || item.summary || "财经快讯");
  const summary = String(item.summary || "");
  const stockList = Array.isArray(item.stockList) ? item.stockList.map(String) : [];
  const relatedStocks = stockList
    .filter((code) => /^[01]\.\d{6}$/.test(code))
    .map((code) => ({ code: code.split(".")[1], name: "", secid: code }));
  const classification = classifyEvent(title, summary, "B");
  const type = eventTypeFor(`${title} ${summary}`, "flash");
  const publishedAt = String(item.showTime || new Date().toISOString());
  const minutes = ageMinutes(publishedAt);
  return {
    id,
    dedupeKey: `fast:${item.code || normalizeTitle(title)}`,
    type: "flash",
    eventType: type,
    title,
    summary,
    source: "东方财富7×24",
    sourceLevel: "B",
    sourceUrl: item.code ? `https://finance.eastmoney.com/a/${item.code}.html` : "https://kuaixun.eastmoney.com/",
    publishedAt,
    firstSeenAt: rememberFirstSeen(id),
    fetchedAt: new Date().toISOString(),
    relatedStocks,
    relatedSectors: relatedSectorsFor(`${title} ${summary}`, stockList),
    freshnessScore: minutes <= 10 ? 100 : minutes <= 30 ? 90 : minutes <= 120 ? 75 : minutes <= 720 ? 55 : 30,
    ageMinutes: minutes,
    isOld: minutes > 1440,
    impactHorizon: horizonFor(type),
    marketConfirmed: false,
    marketConfirmation: "待行情确认",
    status: "active",
    ...classification
  };
}

function normalizeClsTelegraph(item) {
  const idValue = item.id || item.ctime || normalizeTitle(item.title || item.brief);
  const id = `cls-${idValue}`;
  const brief = String(item.brief || item.content || "");
  const title = String(item.title || brief.replace(/^【([^】]+)】/, "$1").slice(0, 80) || "财联社电报");
  const summary = String(item.content || brief || "").replace(/^【[^】]+】/, "").trim();
  const publishedAt = Number(item.ctime)
    ? new Date(Number(item.ctime) * 1000).toISOString()
    : new Date().toISOString();
  const stockRows = Array.isArray(item.stock_list) ? item.stock_list : [];
  const relatedStocks = stockRows
    .map((row) => {
      const rawCode = String(row.stock_code || row.code || row.StockID || "");
      const code = rawCode.match(/\d{6}/)?.[0] || "";
      return {
        code,
        name: String(row.stock_name || row.name || row.StockName || ""),
        secid: code ? `${/^(5|6|9)/.test(code) ? 1 : 0}.${code}` : ""
      };
    })
    .filter((row) => row.code);
  const subjectNames = (Array.isArray(item.subjects) ? item.subjects : [])
    .map((subject) => String(subject.subject_name || subject.name || "").trim())
    .filter(Boolean);
  const minutes = ageMinutes(publishedAt);
  const type = eventTypeFor(`${title} ${summary}`, "flash");
  return {
    id,
    dedupeKey: `cls:${idValue}`,
    type: "flash",
    eventType: type,
    title,
    summary,
    source: "财联社电报",
    sourceLevel: "B",
    sourceUrl: item.id ? `https://www.cls.cn/detail/${item.id}` : "https://www.cls.cn/telegraph",
    publishedAt,
    firstSeenAt: rememberFirstSeen(id),
    fetchedAt: new Date().toISOString(),
    relatedStocks,
    relatedSectors: [...new Set([
      ...subjectNames,
      ...relatedSectorsFor(`${title} ${summary}`)
    ])],
    freshnessScore: minutes <= 10 ? 100 : minutes <= 30 ? 90 : minutes <= 120 ? 75 : minutes <= 720 ? 55 : 30,
    ageMinutes: minutes,
    isOld: minutes > 1440,
    impactHorizon: horizonFor(type),
    marketConfirmed: false,
    marketConfirmation: "待行情确认",
    status: "active",
    ...classifyEvent(title, summary, "B")
  };
}

function normalizeEastAnnouncement(item) {
  const codeRows = Array.isArray(item.codes) ? item.codes : [];
  const code = codeRows[0]?.stock_code || "";
  const id = `east-ann-${item.art_code}`;
  const title = String(item.title || item.title_ch || "公司公告");
  const summary = "";
  const type = eventTypeFor(title, "announcement");
  const classification = classifyEvent(title, summary, "B");
  const publishedAt = String(item.display_time || item.notice_date || new Date().toISOString());
  const minutes = ageMinutes(publishedAt);
  return {
    id,
    dedupeKey: `ann:${item.art_code || normalizeTitle(title)}`,
    type: "announcement",
    eventType: type,
    title,
    summary,
    source: "东方财富公告聚合",
    sourceLevel: "B",
    transportProvider: "东方财富公开网页",
    originAuthority: "待原始披露平台核验",
    sourceUrl: code && item.art_code
      ? `https://data.eastmoney.com/notices/detail/${code}/${item.art_code}.html`
      : "https://www.cninfo.com.cn/new/index",
    publishedAt,
    firstSeenAt: rememberFirstSeen(id),
    fetchedAt: new Date().toISOString(),
    relatedStocks: codeRows.map((row) => ({
      code: String(row.stock_code || ""),
      name: String(row.short_name || ""),
      secid: `${row.market_code || "0"}.${row.stock_code || ""}`
    })),
    relatedSectors: relatedSectorsFor(title),
    category: item.columns?.[0]?.column_name || "公司公告",
    freshnessScore: minutes <= 30 ? 100 : minutes <= 180 ? 90 : minutes <= 720 ? 75 : minutes <= 1440 ? 60 : 35,
    ageMinutes: minutes,
    isOld: minutes > 2880,
    impactHorizon: horizonFor(type),
    marketConfirmed: false,
    marketConfirmation: "待行情确认",
    status: /更正|修订/.test(title) ? "corrected" : "active",
    ...classification
  };
}

function thsRows(json) {
  if (Array.isArray(json?.tables)) {
    const envelope = json.tables[0];
    if (Array.isArray(envelope)) return envelope;
    if (envelope && typeof envelope === "object") {
      const table = envelope.table && typeof envelope.table === "object"
        ? envelope.table
        : envelope;
      const keys = Object.keys(table);
      const metadata = Object.fromEntries(
        Object.entries(envelope).filter(([key]) => key !== "table")
      );
      const length = Math.max(0, ...keys.map((key) => Array.isArray(table[key]) ? table[key].length : 0));
      return Array.from({ length }, (_, index) =>
        ({
          ...metadata,
          ...Object.fromEntries(
            keys.map((key) => [key, Array.isArray(table[key]) ? table[key][index] : table[key]])
          )
        })
      );
    }
  }
  if (Array.isArray(json?.data)) return json.data;
  if (Array.isArray(json?.tables?.data)) return json.tables.data;
  return [];
}

function normalizeThsReport(row) {
  const idValue = row.seq || row.SEQ || row.pdfURL || row.reportTitle;
  const id = `ths-ann-${idValue}`;
  const title = String(row.reportTitle || row.REPORTTITLE || row.title || "公司公告");
  const code = String(row.thscode || row.THSCODE || "").slice(0, 6);
  const name = String(row.secName || row.SECNAME || "");
  const publishedAt = String(row.ctime || row.CTIME || row.reportDate || new Date().toISOString());
  const sourceUrl = String(row.pdfURL || row.PDFURL || "https://www.cninfo.com.cn/new/index");
  const originalOfficial = /(?:cninfo\.com\.cn|sse\.com\.cn|szse\.cn|bse\.cn)/i.test(sourceUrl);
  const minutes = ageMinutes(publishedAt);
  const type = eventTypeFor(title, "announcement");
  return {
    id,
    dedupeKey: `ths:${normalizeTitle(title)}:${code}`,
    type: "announcement",
    eventType: type,
    title,
    summary: "",
    source: "同花顺公告接口",
    sourceLevel: originalOfficial ? "A" : "B",
    transportProvider: "同花顺 QuantAPI",
    originAuthority: originalOfficial ? "官方披露原文" : "待原始披露平台核验",
    sourceUrl,
    publishedAt,
    firstSeenAt: rememberFirstSeen(id),
    fetchedAt: new Date().toISOString(),
    relatedStocks: code ? [{ code, name, secid: "" }] : [],
    relatedSectors: relatedSectorsFor(title),
    category: "公司公告",
    freshnessScore: minutes <= 30 ? 100 : minutes <= 180 ? 90 : minutes <= 720 ? 75 : 55,
    ageMinutes: minutes,
    isOld: minutes > 2880,
    impactHorizon: horizonFor(type),
    marketConfirmed: false,
    marketConfirmation: "待行情确认",
    status: /更正|修订/.test(title) ? "corrected" : "active",
    ...classifyEvent(title, "", originalOfficial ? "A" : "B")
  };
}

async function fetchThsReports(settings) {
  if (!settings?.refreshToken || settings.provider !== "ths") return [];
  const now = new Date();
  const since = new Date(now.getTime() - 36 * 60 * 60 * 1000);
  const dateText = (value) => value.toISOString().replace("T", " ").slice(0, 19);
  const json = await withThsAccessToken(settings.refreshToken, fetchJson, (token) =>
    fetchJson(`${THS_BASE}/report_query`, {
      method: "POST",
      headers: { "Content-Type": "application/json", access_token: token },
      body: JSON.stringify({
        codes: "",
        functionpara: { mode: "allAStock" },
        begincTime: dateText(since),
        endcTime: dateText(now),
        outputpara: "reportDate:Y,thscode:Y,secName:Y,ctime:Y,reportTitle:Y,pdfURL:Y,seq:Y"
      })
    }, 6000).then((result) => {
      if (Number(result?.errorcode || 0) !== 0) {
        throw thsProviderError(result, `同花顺错误 ${result?.errorcode}`);
      }
      return result;
    }), {
      baseUrl: THS_BASE,
      cacheKey: "ths-quant-api",
      failureMessage: "同花顺资讯授权失败"
    });
  return thsRows(json).map(normalizeThsReport);
}

async function cachedSource(id, ttlMs, factory, key = "", options = {}) {
  const cache = sourceCaches[id] || emptySourceCache();
  sourceCaches[id] = cache;
  const clock = typeof options.now === "function" ? options.now : Date.now;
  const nowMs = () => {
    const value = Number(clock());
    return Number.isFinite(value) ? value : Date.now();
  };
  const currentTime = nowMs();
  const configuredMaxStale = Number(
    options.maxStaleMs ?? NEWS_SOURCE_MAX_STALE_MS[id] ?? 5 * 60 * 1000
  );
  const ttlDurationMs = Math.max(0, Number(ttlMs) || 0);
  const maxStaleMs = Math.max(ttlDurationMs, configuredMaxStale || 0);
  if (
    cache?.value &&
    cache.expiresAt > currentTime &&
    (!key || cache.key === key)
  ) {
    return {
      items: cache.value,
      fetchedAt: cache.fetchedAt,
      fromCache: true,
      stale: false
    };
  }
  if (cache.promise && cache.promiseKey === key) return cache.promise;

  const fallbackValue = cache.value && (!key || cache.key === key) ? cache.value : null;
  const fallbackFetchedAt = fallbackValue ? cache.fetchedAt : "";
  const fallbackCachedAtMs = fallbackValue
    ? Number(cache.cachedAtMs || Date.parse(cache.fetchedAt || ""))
    : Number.NaN;
  const generation = Number(cache.generation || 0) + 1;
  cache.generation = generation;
  const promise = (async () => {
    await Promise.resolve();
    try {
      const items = await factory();
      const cachedAtMs = nowMs();
      const fetchedAt = new Date(cachedAtMs).toISOString();
      if (cache.generation === generation) {
        cache.value = items;
        cache.expiresAt = cachedAtMs + ttlDurationMs;
        cache.fetchedAt = fetchedAt;
        cache.cachedAtMs = cachedAtMs;
        cache.key = key;
      }
      return { items, fetchedAt, fromCache: false, stale: false };
    } catch (error) {
      const cacheAgeMs = Number.isFinite(fallbackCachedAtMs)
        ? Math.max(0, nowMs() - fallbackCachedAtMs)
        : Number.POSITIVE_INFINITY;
      if (fallbackValue && cacheAgeMs <= maxStaleMs) {
        return {
          items: fallbackValue,
          fetchedAt: fallbackFetchedAt,
          fromCache: true,
          stale: true,
          warning: String(error?.message || error)
        };
      }
      throw error;
    } finally {
      if (cache.promise === promise) {
        cache.promise = null;
        cache.promiseKey = "";
      }
    }
  })();
  cache.promise = promise;
  cache.promiseKey = key;
  return promise;
}

function cachedSourceStatus(itemCount, result) {
  const warning = String(result?.warning || "").trim();
  const stale = Boolean(result?.stale);
  return {
    message: `${itemCount}条${stale ? " · 使用缓存" : ""}${
      stale && warning ? ` · 降级原因：${warning}` : ""
    }`,
    warning
  };
}

async function fetchPublicFeed(settings) {
  const fastUrl = new URL(FAST_NEWS_URL);
  fastUrl.searchParams.set("client", "web");
  fastUrl.searchParams.set("biz", "web_724");
  fastUrl.searchParams.set("fastColumn", "102");
  fastUrl.searchParams.set("sortEnd", "");
  fastUrl.searchParams.set("pageSize", "80");
  fastUrl.searchParams.set("req_trace", String(Date.now()));
  const announcementUrl = new URL(ANNOUNCEMENT_URL);
  announcementUrl.searchParams.set("sr", "-1");
  announcementUrl.searchParams.set("page_size", "80");
  announcementUrl.searchParams.set("page_index", "1");
  announcementUrl.searchParams.set("ann_type", "A");
  announcementUrl.searchParams.set("client_source", "web");
  const clsUrl = new URL(CLS_TELEGRAPH_URL);
  clsUrl.searchParams.set("rn", "60");
  clsUrl.searchParams.set("lastTime", String(Math.floor(Date.now() / 1000)));
  clsUrl.searchParams.set("name", "telegraph");

  const thsEnabled = Boolean(settings?.refreshToken && settings?.provider === "ths");
  const results = await Promise.allSettled([
    cachedSource(
      "fast",
      6000,
      async () => {
        const json = await fetchJson(
          fastUrl.toString(),
          { headers: { Referer: "https://kuaixun.eastmoney.com/" } },
          5000
        );
        return (json?.data?.fastNewsList || []).map(normalizeFastNews);
      }
    ),
    cachedSource(
      "cls",
      6000,
      async () => {
        const json = await fetchJson(
          clsUrl.toString(),
          { headers: { Referer: "https://www.cls.cn/telegraph" } },
          5000
        );
        return (json?.data?.roll_data || []).map(normalizeClsTelegraph);
      }
    ),
    cachedSource(
      "announcement",
      15000,
      async () => {
        const json = await fetchJson(announcementUrl.toString(), {}, 7000);
        return (json?.data?.list || []).map(normalizeEastAnnouncement);
      }
    ),
    thsEnabled
      ? cachedSource(
          "ths",
          30000,
          () => fetchThsReports(settings),
          settings.refreshToken
        )
      : Promise.resolve({
          items: [],
          fetchedAt: "",
          fromCache: false,
          stale: false,
          disabled: true
        })
  ]);
  const fastResult = results[0].status === "fulfilled" ? results[0].value : null;
  const clsResult = results[1].status === "fulfilled" ? results[1].value : null;
  const announcementResult = results[2].status === "fulfilled" ? results[2].value : null;
  const thsResult = results[3].status === "fulfilled" ? results[3].value : null;
  const fast = fastResult?.items || [];
  const clsTelegraphs = clsResult?.items || [];
  const announcements = announcementResult?.items || [];
  const thsReports = thsResult?.items || [];
  const fastStatus = cachedSourceStatus(fast.length, fastResult);
  const clsStatus = cachedSourceStatus(clsTelegraphs.length, clsResult);
  const announcementStatus = cachedSourceStatus(announcements.length, announcementResult);
  const thsStatus = cachedSourceStatus(thsReports.length, thsResult);
  const status = [
    {
      id: "fast",
      name: "7×24财经快讯",
      ok: results[0].status === "fulfilled",
      level: "B",
      message: results[0].status === "fulfilled"
        ? fastStatus.message
        : results[0].reason?.message,
      warning: results[0].status === "fulfilled"
        ? fastStatus.warning
        : String(results[0].reason?.message || results[0].reason || ""),
      fetchedAt: fastResult?.fetchedAt || "",
      pollSeconds: 6,
      stale: Boolean(fastResult?.stale)
    },
    {
      id: "cls",
      name: "财联社电报",
      ok: results[1].status === "fulfilled",
      level: "B",
      message: results[1].status === "fulfilled"
        ? clsStatus.message
        : results[1].reason?.message,
      warning: results[1].status === "fulfilled"
        ? clsStatus.warning
        : String(results[1].reason?.message || results[1].reason || ""),
      fetchedAt: clsResult?.fetchedAt || "",
      pollSeconds: 6,
      stale: Boolean(clsResult?.stale)
    },
    {
      id: "announcement",
      name: "公司公告聚合",
      ok: results[2].status === "fulfilled",
      level: "B",
      message: results[2].status === "fulfilled"
        ? announcementStatus.message
        : results[2].reason?.message,
      warning: results[2].status === "fulfilled"
        ? announcementStatus.warning
        : String(results[2].reason?.message || results[2].reason || ""),
      fetchedAt: announcementResult?.fetchedAt || "",
      pollSeconds: 15,
      stale: Boolean(announcementResult?.stale)
    },
    {
      id: "ths",
      name: "同花顺公告",
      ok: thsEnabled ? results[3].status === "fulfilled" : null,
      level: "A/B",
      message: thsEnabled
        ? results[3].status === "fulfilled"
          ? thsStatus.message
          : results[3].reason?.message
        : "未启用",
      warning: thsEnabled
        ? results[3].status === "fulfilled"
          ? thsStatus.warning
          : String(results[3].reason?.message || results[3].reason || "")
        : "",
      fetchedAt: thsResult?.fetchedAt || "",
      pollSeconds: 30,
      stale: Boolean(thsResult?.stale)
    }
  ];
  if (!fast.length && !clsTelegraphs.length && !announcements.length && !thsReports.length) {
    const sourceWarnings = status.map((source) => source.warning).filter(Boolean);
    throw new Error(
      `实时资讯源暂时不可用${sourceWarnings.length ? `：${sourceWarnings.join("；")}` : ""}`
    );
  }
  return { items: [...thsReports, ...announcements, ...clsTelegraphs, ...fast], status };
}

function dedupeItems(items) {
  const seenIds = new Set();
  const titleWindow = new Map();
  const result = [];
  for (const item of items.sort((a, b) => parseTime(b.publishedAt) - parseTime(a.publishedAt))) {
    if (seenIds.has(item.id)) continue;
    seenIds.add(item.id);
    const titleKey = normalizeTitle(item.title);
    const prior = titleWindow.get(titleKey);
    if (prior && Math.abs(parseTime(prior.publishedAt) - parseTime(item.publishedAt)) < 12 * 60 * 60 * 1000) {
      prior.duplicateCount = (prior.duplicateCount || 1) + 1;
      prior.sourceRefs = [...new Set([...(prior.sourceRefs || [prior.source]), item.source])];
      if (item.sourceLevel === "A" && prior.sourceLevel !== "A") {
        Object.assign(prior, { ...item, duplicateCount: prior.duplicateCount, sourceRefs: prior.sourceRefs });
      }
      continue;
    }
    item.duplicateCount = 1;
    item.sourceRefs = [item.source];
    titleWindow.set(titleKey, item);
    result.push(item);
  }
  return result;
}

function matchesCollection(item, collection = []) {
  const codes = new Set(collection.map((entry) => String(entry.code || "")));
  const names = collection.map((entry) => String(entry.name || "")).filter(Boolean);
  const industries = collection.map((entry) => String(entry.industry || "")).filter(Boolean);
  const text = `${item.title} ${item.summary}`;
  return item.relatedStocks.some((stock) => codes.has(String(stock.code))) ||
    names.some((name) => text.includes(name)) ||
    industries.some((industry) => item.relatedSectors.includes(industry) || text.includes(industry));
}

function filterItems(items, input) {
  const scope = input?.scope || "all";
  const query = String(input?.query || "").trim().toLowerCase();
  const direction = String(input?.direction || "all");
  const contentType = String(input?.contentType || "all");
  return items.filter((item) => {
    const text = [
      item.title,
      item.summary,
      item.source,
      item.eventType,
      ...item.relatedSectors,
      ...item.relatedStocks.flatMap((stock) => [stock.code, stock.name])
    ].join(" ").toLowerCase();
    if (contentType !== "all" && item.type !== contentType) return false;
    if (query && !text.includes(query)) return false;
    if (direction !== "all" && item.direction !== direction) return false;
    if (scope === "limitUp" && !matchesCollection(item, input.limitUps)) return false;
    if (scope === "watchlist" && !matchesCollection(item, input.watchlist)) return false;
    if (scope === "holdings" && !matchesCollection(item, input.holdings)) return false;
    if (scope === "stock") {
      const stock = input.currentStock;
      if (!stock || !matchesCollection(item, [stock])) return false;
    }
    if (scope === "sector") {
      const sector = String(input.currentSector || "").trim();
      if (!sector || (!text.includes(sector.toLowerCase()) && !item.relatedSectors.some((name) => name.toLowerCase().includes(sector.toLowerCase())))) {
        return false;
      }
    }
    return true;
  });
}

function isBroadcastWorthy(item) {
  const importance = Number(item?.importanceScore || 0);
  const risk = Number(item?.riskSeverity || 0);
  return risk >= 2 ||
    importance >= 85 ||
    (item?.sourceLevel === "A" && importance >= 75);
}

async function getNewsFeed(input = {}, settings = {}) {
  const feed = await fetchPublicFeed(settings);
  const deduped = dedupeItems(feed.items);
  const filtered = filterItems(deduped, input);
  const limit = Math.max(10, Math.min(200, Number(input.limit) || 100));
  return {
    items: filtered.slice(0, limit).map((item) => ({
      ...item,
      autoBroadcast: isBroadcastWorthy(item)
    })),
    total: filtered.length,
    unfilteredTotal: deduped.length,
    updatedAt: new Date().toISOString(),
    refreshAfterSeconds: Math.max(
      5,
      Math.min(30, Number(settings.newsRefreshSeconds) || 6)
    ),
    mode: "极速准实时",
    collectionPolicy: "财联社6秒 · 快讯6秒 · 公告15秒 · 同花顺增强30秒",
    sourceStatus: feed.status
  };
}

function resetNewsCache(options = {}) {
  const clearValues = options === true || options?.clear === true;
  for (const cache of Object.values(sourceCaches)) {
    cache.expiresAt = 0;
    cache.generation = Number(cache.generation || 0) + 1;
    cache.promise = null;
    cache.promiseKey = "";
    if (clearValues) {
      cache.value = null;
      cache.fetchedAt = "";
      cache.cachedAtMs = 0;
      cache.key = "";
    }
  }
}

module.exports = {
  getNewsFeed,
  resetNewsCache,
  cachedSource,
  cachedSourceStatus,
  NEWS_SOURCE_MAX_STALE_MS,
  normalizeFastNews,
  normalizeClsTelegraph,
  normalizeEastAnnouncement,
  normalizeThsReport,
  thsRows,
  dedupeItems,
  filterItems,
  classifyEvent,
  isBroadcastWorthy
};
