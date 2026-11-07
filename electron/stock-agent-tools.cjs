"use strict";

/**
 * AI 问股的「工具」（1.6.53）：AI 分析个股时可以自己决定调用哪些数据。
 * 每个工具只读软件已有的数据源（行情、日线、分时、公告、资讯、板块、同花顺扶摇短线数据、策略引擎、打分框架），
 * 返回精简后的结构化数据和一句话摘要。不含账户、持仓或密钥；结果有长度上限。
 * 同一份数据 2 分钟内重复调用直接用缓存（追问时不再重复联网）。
 */

const { createServiceRuntime } = require("./service-runtime.cjs");
const { BoundedCache } = require("./bounded-cache.cjs");

const clip = (value, max) => {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
};
const finite = value => typeof value === "number" && Number.isFinite(value) ? value : null;
const round = (value, digits = 2) => finite(value) === null ? null : Number(value.toFixed(digits));
const yi = value => finite(value) === null ? null : round(value / 1e8, 2);
const take = (value, max) => (Array.isArray(value) ? value : []).slice(0, max);
const intArg = (value, low, high, fallback) => {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) ? Math.max(low, Math.min(high, parsed)) : fallback;
};
/** 资讯时间统一成北京时间「MM-DD HH:mm」。 */
const beijingTime = value => {
  const text = String(value || "").trim();
  // 不带时区的时间本来就是北京时间，直接截取；带时区的换算成北京时间。
  if (!/(Z|[+-]\d{2}:?\d{2})$/.test(text)) return text.replace("T", " ").slice(5, 16);
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? new Date(ms + 8 * 3600000).toISOString().slice(5, 16).replace("T", " ") : clip(text, 16);
};
/** 扶摇短线数据的取数日期（北京时间 YYYY-MM-DD）。涨停池等是「最近交易日」的数据，盘前/周末取到的是上一交易日。 */
const tradeDateOf = value => {
  const ms = Date.parse(String(value?.fetchedAt || ""));
  return Number.isFinite(ms) ? new Date(ms + 8 * 3600000).toISOString().slice(0, 10) : "";
};
/** 等 promise 最多 ms 毫秒；超时或失败返回 null（不影响其他数据）。 */
const within = (promise, ms) => new Promise(resolve => {
  const timer = setTimeout(() => resolve(null), ms); timer.unref?.();
  Promise.resolve(promise).then(value => { clearTimeout(timer); resolve(value); }, () => { clearTimeout(timer); resolve(null); });
});
const DIRECTION_LABEL = { positive: "利好", negative: "利空", mixed: "多空交织", neutral: "中性" };
const toolError = message => Object.assign(new Error(message), { code: "TOOL_FAILED" });

/** 6 位 A 股代码 → 证券标识（沪市 6 开头 secid 前缀 1，其余 0）。 */
function securityOf(code, name = "") {
  const value = String(code || "").match(/\d{6}/)?.[0] || "";
  if (!value) throw toolError("请给出 6 位股票代码（不知道代码时先用 search_stock 查）");
  return { code: value, name: String(name || value), secid: `${value.startsWith("6") ? "1" : "0"}.${value}`, assetType: "stock" };
}

const TOOLS = [
  { id: "search_stock", name: "查找股票", description: "按名称、代码或拼音首字母查 A 股代码（用户只说了名字时先查）", args: '{"query":"贵州茅台"}' },
  { id: "quote", name: "实时行情", description: "现价、涨跌幅、开高低、成交额、换手、振幅、涨跌停价、总市值和流通市值", args: '{"code":"600519"}' },
  { id: "profile", name: "日线体检", description: "近 120 日：5/20/60 日涨幅、均线排列、量比、连板与近 20 日涨停/炸板次数、MACD、RSI、乖离、跳空缺口、软件算好的支撑位和压力位、情境标签、公告摘要", args: '{"code":"600519"}' },
  { id: "kline", name: "近期K线", description: "最近 N 个交易日的日K（开高低收、涨跌幅、成交额、换手），N 最多 60", args: '{"code":"600519","days":20}' },
  { id: "intraday", name: "当日分时", description: "当日分时走势：开盘、最高最低及时间、均价线、现价相对均价、早盘尾盘涨跌、半小时节点价格、上下午成交额", args: '{"code":"600519"}' },
  { id: "strategies", name: "策略信号", description: "软件「策略选股」在用策略（含精选策略）里，这只股票按最近交易日收盘命中了哪些、理由和失效价", args: '{"code":"600519"}' },
  { id: "score", name: "框架打分", description: "按当前 AI 打分框架算的基础分（0–100）、各维度得分与说明、命中的硬规则", args: '{"code":"600519"}' },
  { id: "diagnosis", name: "软件综合研判", description: "个股分析页的综合评级（S/A/B/C）、综合分、交易信号与 ATR 止损止盈价、策略因子是否满足、风险提示、板块强弱判断（较慢）", args: '{"code":"600519"}' },
  { id: "limit_status", name: "涨停与龙虎榜", description: "最近交易日同花顺扶摇短线数据里这只股票的情况：是否涨停（连板、涨停原因、首封时间、封单）、炸板、跌停、热股榜/飙升榜排名、龙虎榜（净买入、机构与游资、上榜席位）、异动原因", args: '{"code":"600519"}' },
  { id: "sector", name: "所属板块", description: "所属行业今日涨跌（同花顺行业榜）、在全部行业里的排名、涨跌家数、涨停家数、主力净流入，这只股票在板块里的涨幅排名、板块领涨和领跌股", args: '{"code":"600519"}' },
  { id: "announcements", name: "公司公告", description: "最近 8 条公司公告（日期、标题、软件判断的利好利空方向和风险等级）", args: '{"code":"600519"}' },
  { id: "news", name: "相关资讯", description: "财联社等快讯里提到这只股票或其行业的最新资讯（标题、时间、方向）", args: '{"code":"600519"}' },
  { id: "market", name: "市场情绪", description: "当日短线情绪：涨停/跌停/炸板家数、封板率、最高连板、涨停原因前列、热股，以及行业涨幅前列和后列", args: "{}" },
  { id: "sector_rank", name: "板块排行", description: "行业或概念板块按涨幅、涨停家数或主力净流入排行", args: '{"kind":"industry|concept","sortBy":"change|limitUps|netInflow","top":10}' }
];
const TOOL_BY_ID = new Map(TOOLS.map(tool => [tool.id, tool]));

/** 写进提示词的工具清单。 */
function toolCatalogText() {
  return TOOLS.map(tool => `- ${tool.id}「${tool.name}」：${tool.description}；参数 ${tool.args}`).join("\n");
}

const CACHE_TTL_MS = 2 * 60 * 1000;
const CACHE_MAX = 120;
const TOOL_TIMEOUT_MS = 30_000;
const SLOW_TOOL_TIMEOUT_MS = 50_000;

/**
 * @param {object} sources 主进程提供的数据读取函数（见 main.cjs 的 stockAgentSources）。
 * @param {{ now?: () => number }} [options]
 */
function createStockAgentTools(sources, { now = () => Date.now(), toolTimeoutMs = TOOL_TIMEOUT_MS, slowToolTimeoutMs = SLOW_TOOL_TIMEOUT_MS } = {}) {
  const runtime = createServiceRuntime({ jobOptions: { maxActive: 24, maxQueued: 0 }, cacheJobOptions: { maxActive: 24, maxQueued: 0 }, now });
  const cache = new BoundedCache({ maxEntries: CACHE_MAX, maxBytes: 8 * 1024 * 1024, now });
  let sequence = 0;
  const source = (name, ...args) => runtime.track(() => sources[name](...args, { signal: runtime.signal(), track: factory => runtime.track(factory) }));
  const names = new Map();
  const remember = (code, name) => { if (/^\d{6}$/.test(String(code)) && name && name !== code) { names.set(String(code), clip(name, 12)); while (names.size > CACHE_MAX) names.delete(names.keys().next().value); } };
  const nameOf = code => names.get(code) || "";
  const cached = (key, produce) => runtime.cached(cache, key, CACHE_TTL_MS, produce);
  const fuyao = () => cached("fuyao", async () => { const value = await source("fuyao"); return value?.available ? value : null; });
  const profileOf = security => cached(`profile:${security.code}`, async () => {
    const profile = await source("profile", { code: security.code, name: security.name || nameOf(security.code) || security.code });
    if (!profile) throw toolError("日线没读到，暂时无法体检");
    remember(profile.code, profile.name);
    return profile;
  });
  const quoteOf = security => cached(`quote:${security.code}`, async () => {
    const value = await source("quote", security);
    const quote = value?.quote;
    if (!quote || !(finite(quote.latest) > 0)) throw toolError("行情没取到");
    remember(security.code, quote.name);
    return { quote, warning: value?.warning || "" };
  });
  const securityArg = args => securityOf(args?.code, nameOf(String(args?.code || "").match(/\d{6}/)?.[0] || ""));

  const run = {
    async search_stock(args) {
      const query = clip(args?.query, 20);
      if (!query) throw toolError("请给出要查的股票名称或代码");
      const rows = await cached(`search:${query}`, () => source("search", query));
      const stocks = take((Array.isArray(rows) ? rows : []).filter(row => row && row.assetType === "stock" && /^\d{6}$/.test(String(row.code))), 6)
        .map(row => { remember(row.code, row.name); return { code: String(row.code), name: clip(row.name, 12), market: clip(row.marketName || "A股", 6) }; });
      if (!stocks.length) throw toolError(`没有找到「${query}」对应的 A 股`);
      return { summary: `找到 ${stocks.map(item => `${item.name}(${item.code})`).join("、")}`, data: { query, stocks } };
    },

    async quote(args) {
      const security = securityArg(args);
      const { quote, warning } = await quoteOf(security);
      const data = {
        code: security.code, name: clip(quote.name || nameOf(security.code), 12), latest: round(finite(quote.latest)), changePct: round(finite(quote.changePct)),
        open: round(finite(quote.open)), high: round(finite(quote.high)), low: round(finite(quote.low)), preClose: round(finite(quote.preClose)),
        amountYi: yi(finite(quote.amount)), turnoverPct: round(finite(quote.turnover)), amplitudePct: round(finite(quote.amplitude)),
        limitUpPrice: round(finite(quote.limitUp)), limitDownPrice: round(finite(quote.limitDown)),
        totalMarketCapYi: finite(quote.totalMarketCap) > 0 ? yi(quote.totalMarketCap) : null, floatMarketCapYi: finite(quote.floatMarketCap) > 0 ? yi(quote.floatMarketCap) : null,
        ...(finite(quote.pe) !== null ? { pe: round(quote.pe) } : {}), ...(finite(quote.pb) !== null ? { pb: round(quote.pb) } : {}),
        industry: clip(quote.industry, 12), quoteAt: String(quote.quoteAt || ""), ...(warning ? { warning: clip(warning, 80) } : {})
      };
      const atLimit = data.limitUpPrice && data.latest !== null && Math.abs(data.latest - data.limitUpPrice) < 0.005 ? "（涨停价）" : data.limitDownPrice && data.latest !== null && Math.abs(data.latest - data.limitDownPrice) < 0.005 ? "（跌停价）" : "";
      return { summary: `${data.name} 现价 ${data.latest ?? "--"}${atLimit}，涨跌 ${data.changePct ?? "--"}%，成交 ${data.amountYi ?? "--"} 亿`, data };
    },

    async profile(args) {
      const security = securityArg(args);
      const p = await profileOf(security);
      const situation = typeof sources.situationOf === "function" ? take(sources.situationOf(p), 6) : [];
      const data = {
        code: p.code, name: p.name, industry: p.industry, asOfDate: p.asOfDate, bars: p.bars, latest: p.latest, changePct: p.changePct,
        return5: p.return5, return20: p.return20, return60: p.return60, ma: p.ma, alignment: p.alignment, trend: clip(p.trend, 40),
        volumeRatio: p.volumeRatio, amountYi: p.amountYi ?? null, avgAmount20Yi: p.avgAmount20Yi ?? null, turnover: p.turnover ?? null,
        consecutiveBoards: p.consecutiveBoards, limitUps20: p.limitUps20, broken20: p.broken20, lastLimitDate: p.lastLimitDate || "", daysSinceLimit: p.daysSinceLimit,
        high20: p.high20, low20: p.low20, high60: p.high60, low60: p.low60, fromHigh20Pct: p.fromHigh20Pct ?? null, fromLow20Pct: p.fromLow20Pct ?? null,
        macd: p.macd, rsi6: p.rsi6, rsi14: p.rsi14, bias5: p.bias5, gaps: take(p.gaps, 3),
        support: take(p.support, 3), resistance: take(p.resistance, 3), situation,
        announcements: p.announcementsAvailable === false ? "公告未取到" : take(p.announcements, 5).map(item => ({ date: item.date, title: clip(item.title, 40), direction: item.direction, risk: item.risk }))
      };
      const levels = [data.support?.[0] ? `支撑 ${data.support[0].price}(${data.support[0].label})` : "", data.resistance?.[0] ? `压力 ${data.resistance[0].price}(${data.resistance[0].label})` : ""].filter(Boolean).join("，");
      return { summary: `${p.name}：${p.alignment || "--"}，20日 ${p.return20 ?? "--"}%，量比 ${p.volumeRatio ?? "--"}${levels ? `，${levels}` : ""}`, data };
    },

    async kline(args) {
      const security = securityArg(args);
      const days = intArg(args?.days, 5, 60, 20);
      const rows = await cached(`daily:${security.code}`, () => source("dailyRows", security, 120));
      const list = take((Array.isArray(rows) ? rows : []).slice(-days), days);
      if (!list.length) throw toolError("日K没读到");
      const bars = list.map((row, index) => {
        const previous = index ? list[index - 1].close : (rows.length > days ? rows[rows.length - days - 1]?.close : null);
        const pct = finite(row.changePct) ?? (finite(previous) > 0 && finite(row.close) ? (row.close / previous - 1) * 100 : null);
        return { date: String(row.date || "").slice(0, 10), open: round(finite(row.open)), high: round(finite(row.high)), low: round(finite(row.low)), close: round(finite(row.close)),
          pct: round(pct), amountYi: yi(finite(row.amount)), turnover: round(finite(row.turnover)) };
      });
      const first = bars[0], last = bars.at(-1);
      const change = finite(first?.open) && finite(last?.close) ? round((last.close / (bars.length > 1 && finite(list[0].close) ? list[0].close : first.open) - 1) * 100) : null;
      return { summary: `${bars.length} 根日K（${first.date}~${last.date}），区间涨跌 ${change ?? "--"}%`, data: { code: security.code, bars } };
    },

    async intraday(args) {
      const security = securityArg(args);
      const share = await cached(`time:${security.code}`, () => source("timeShare", security));
      const rows = (Array.isArray(share?.rows) ? share.rows : []).filter(row => finite(row?.close) > 0);
      if (!rows.length) throw toolError("分时没取到（休市日或数据源不可用）");
      const preClose = finite(share.preClose);
      const time = row => String(row.date || "").slice(11, 16);
      const pct = price => preClose > 0 && finite(price) !== null ? round((price / preClose - 1) * 100) : null;
      let high = rows[0], low = rows[0];
      for (const row of rows) { if (row.close > high.close) high = row; if (row.close < low.close) low = row; }
      const last = rows.at(-1), first = rows[0];
      const average = finite(last.average);
      const at = hhmm => rows.filter(row => time(row) <= hhmm).at(-1);
      const nodes = ["09:45", "10:00", "10:30", "11:00", "11:30", "13:30", "14:00", "14:30", "15:00"].map(hhmm => {
        const row = at(hhmm);
        return row && time(row) >= hhmm.replace(/:(\d{2})$/, (_, m) => `:${String(Math.max(0, Number(m) - 15)).padStart(2, "0")}`) ? { time: hhmm, price: round(row.close), pct: pct(row.close) } : null;
      }).filter(Boolean);
      const amountOf = list => list.reduce((sum, row) => sum + (finite(row.amount) || 0), 0);
      const morning = rows.filter(row => time(row) <= "11:30"), afternoon = rows.filter(row => time(row) >= "13:00");
      const above = rows.filter(row => finite(row.average) && row.close >= row.average).length;
      const data = {
        code: security.code, date: String(share.tradingDate || share.date || String(first.date || "").slice(0, 10)), preClose: round(preClose),
        open: round(first.close), openPct: pct(first.close), latest: round(last.close), latestPct: pct(last.close), latestTime: time(last),
        high: { price: round(high.close), pct: pct(high.close), time: time(high) }, low: { price: round(low.close), pct: pct(low.close), time: time(low) },
        average: round(average), latestVsAveragePct: average ? round((last.close / average - 1) * 100) : null,
        minutesAboveAveragePct: rows.length ? Math.round(above / rows.length * 100) : null,
        morningAmountYi: yi(amountOf(morning)), afternoonAmountYi: yi(amountOf(afternoon)), nodes, ...(share.note ? { note: clip(share.note, 40) } : {})
      };
      return { summary: `分时 ${data.latestTime} ${data.latest}(${data.latestPct ?? "--"}%)，最高 ${data.high.price}@${data.high.time}，均价 ${data.average ?? "--"}`, data };
    },

    async strategies(args) {
      const security = securityArg(args);
      const value = await cached(`strategies:${security.code}`, () => source("strategies", { ...security, name: nameOf(security.code) || security.name }));
      const hits = take(value?.hits, 12).map(item => ({ name: clip(item.name, 16), featured: item.featured === true, signalDate: item.signalDate || "",
        reasons: take(item.reasons, 3).map(text => clip(text, 40)), invalidationPrice: finite(item.invalidationPrice), notes: take(item.notes, 2).map(text => clip(text, 40)) }));
      const data = { asOfDate: value?.asOfDate || "", evaluated: value?.evaluated !== false, skippedReason: clip(value?.skippedReason, 64),
        activeStrategies: value?.activeCount ?? null, featuredStrategies: value?.featuredCount ?? null, hits };
      const summary = !data.evaluated ? `没有参与策略计算：${data.skippedReason || "数据不足"}`
        : hits.length ? `命中 ${hits.length} 条：${hits.slice(0, 4).map(item => `${item.name}${item.featured ? "(精选)" : ""}`).join("、")}` : `${data.activeStrategies ?? ""} 条在用策略都没有命中`;
      return { summary, data };
    },

    async score(args) {
      const security = securityArg(args);
      const [profile, board] = await Promise.all([profileOf(security), fuyao().catch(() => null)]);
      let market = null;
      try { market = board ? sources.marketContext(board) : null; } catch { market = null; }
      // 和选股打分一致：当日涨停原因（题材）参与「题材」维度和情境判断。
      const reason = board?.limitUp?.byCode?.[security.code]?.reason;
      const evaluation = sources.score(reason && !profile.limitReason ? { ...profile, limitReason: clip(reason, 40) } : profile, market);
      const data = { framework: clip(evaluation?.name, 16), base: finite(evaluation?.base),
        dims: take(evaluation?.dims, 10).map(item => ({ label: clip(item.label, 8), weight: finite(item.weight), score: finite(item.score), note: clip(item.note, 40) })),
        caps: take(evaluation?.caps, 4).map(item => clip(item, 30)), ...(Array.isArray(evaluation?.plays) ? { plays: take(evaluation.plays, 3).map(item => clip(item?.name || item, 12)) } : {}),
        ...(Array.isArray(evaluation?.situation) ? { situation: take(evaluation.situation, 6) } : {}) };
      return { summary: `${data.framework || "框架"}基础分 ${data.base ?? "--"}${data.caps.length ? `，命中硬规则：${data.caps.join("、")}` : ""}`, data };
    },

    async diagnosis(args) {
      const security = securityArg(args);
      const value = await cached(`diagnosis:${security.code}`, () => source("diagnosis", { ...security, name: nameOf(security.code) || security.name }));
      const a = value?.analysis || {};
      const plan = a.tradePlan || {};
      const signalText = { BUY_AGGRESSIVE: "积极买入", BUY: "买入", OBSERVE: "观察", WAIT: "等待" }[String(a.actionSignal || plan.signal || "")] || String(a.actionSignal || "");
      const data = {
        grade: a.grade || "", score: finite(a.mrs) === null ? null : Math.round(a.mrs), signal: signalText,
        stopLossPrice: finite(plan.stopLossPrice), stopLossPct: finite(plan.stopLossDistancePercent), takeProfitPrice: finite(plan.takeProfitPrice),
        trend: clip(a.trendLabel, 20), structureScore: finite(a.structureScore), marketScore: finite(a.marketScore),
        factors: take(a.strategyResults, 10).map(item => ({ name: clip(item.label || item.name, 12), matched: item.matched === true, detail: clip(item.detail, 40) })),
        risks: take(a.risks, 6).map(item => clip(typeof item === "string" ? item : item?.label || item?.detail, 40)).filter(Boolean),
        sector: value?.sector ? { name: clip(value.sector.name, 12), verdict: clip(value.sector.verdict, 12), score: finite(value.sector.score) === null ? null : Math.round(value.sector.score) } : null,
        limitEvent: a.limitEvent ? { date: String(a.limitEvent.date || ""), daysSince: finite(a.daysSince), node: clip(a.exactNode?.label || a.exactNode || "", 12) } : null
      };
      return { summary: `软件评级 ${data.grade || "--"}（${data.score ?? "--"} 分），信号「${data.signal || "--"}」${data.stopLossPrice ? `，ATR 止损 ${data.stopLossPrice}` : ""}`, data };
    },

    async limit_status(args) {
      const security = securityArg(args);
      const value = await fuyao();
      if (!value) throw toolError("同花顺扶摇短线数据暂不可用（未配置 API Key 或本次没取到）");
      const code = security.code;
      const up = value.limitUp?.byCode?.[code];
      const broken = value.limitBreak?.byCode?.[code];
      const down = value.limitDown?.byCode?.[code];
      const dragon = value.dragonTiger?.byCode?.[code];
      const rankIn = list => { const row = (Array.isArray(list) ? list : []).find(item => item?.code === code); return row ? finite(row.rank) : null; };
      const lists = value.hotLists || {};
      const hot = { day: rankIn(lists.day?.hot || value.hot), daySkyrocket: rankIn(lists.day?.skyrocket || value.skyrocket), hour: rankIn(lists.hour?.hot), hourSkyrocket: rankIn(lists.hour?.skyrocket) };
      const anomalies = take((value.anomalies || []).filter(item => item?.code === code), 3).map(item => ({ tag: clip(item.tag, 6), content: clip(item.content, 120), keywords: take(item.keywords, 4) }));
      const ladderDays = take(value.ladder?.days, 5).map(day => {
        const tier = (day.tiers || []).find(item => (item.stocks || []).some(stock => stock.code === code));
        return tier ? { date: day.date, level: tier.label, nextDay: (tier.stocks.find(stock => stock.code === code)?.nextDay) || null } : null;
      }).filter(Boolean);
      const data = {
        // 扶摇数据对应的交易日（北京时间），不用 UTC 时间戳截日期。
        date: tradeDateOf(value),
        limitUp: up ? { boards: finite(up.boards), boardsText: clip(up.boardsText, 10), reason: clip(up.reason, 40), firstSealTime: String(up.limitUpTime || ""), sealYi: yi(finite(up.sealMoney)) } : null,
        limitBreak: broken ? { changePct: round(finite(broken.changePct)), openTimes: finite(broken.openTimes) } : null,
        limitDown: down ? { changePct: round(finite(down.changePct)), firstLimitTime: down.firstLimitTime || "", lastLimitTime: down.lastLimitTime || "" } : null,
        hotRank: Object.fromEntries(Object.entries(hot).filter(([, rank]) => rank !== null)),
        dragonTiger: dragon ? { date: value.dragonTiger.date || "", changePct: round(finite(dragon.changePct)), netYi: yi(finite(dragon.net)), buyYi: yi(finite(dragon.buy)), sellYi: yi(finite(dragon.sell)),
          orgNetYi: yi(finite(dragon.orgNet)), hotMoneyNetYi: yi(finite(dragon.hotMoneyNet)), reason: clip(dragon.reason, 30), concepts: take(dragon.concepts, 4), desks: take(dragon.desks, 4) } : null,
        ladder: ladderDays, anomalies,
        market: { limitUpCount: value.limitUp?.count ?? null, maxBoards: value.limitUp?.maxBoards ?? null }
      };
      const parts = [
        `最近交易日数据${data.date ? `（${data.date} 取数）` : ""}`,
        up ? `涨停（${up.boardsText || `${up.boards || 1}板`}，${clip(up.reason, 16) || "原因未注明"}）` : broken ? `炸板（开板 ${broken.openTimes ?? "--"} 次）` : down ? "跌停" : "不在涨停/炸板/跌停池",
        dragon ? `龙虎榜${value.dragonTiger?.date && value.dragonTiger.date !== data.date ? `（${value.dragonTiger.date}）` : ""}净买 ${yi(finite(dragon.net)) ?? "--"} 亿` : "",
        hot.day ? `24小时热股第 ${hot.day}` : "", anomalies.length ? `异动：${anomalies[0].tag}` : ""
      ].filter(Boolean);
      return { summary: parts.join("，"), data };
    },

    async sector(args) {
      const security = securityArg(args);
      const industry = await cached(`industry:${security.code}`, async () => {
        const value = await source("industry", security.code).catch(() => "");
        return value || quoteOf(security).then(item => String(item.quote.industry || "")).catch(() => "");
      });
      if (!industry) throw toolError("没查到所属行业");
      // 今日涨跌、涨跌家数、资金和行业排名取「板块强度」页同一份同花顺行业榜；成分股明细只用来排个股名次和找领涨股。
      // （板块指数日线可能还没更新到今天，单独用它算「今日涨幅」会和成分股对不上。）
      const [detail, board] = await Promise.all([
        cached(`sector:${industry}`, () => source("sectorDetail", industry)).catch(() => null),
        // 行业榜较慢时不拖住整个工具：最多等 15 秒，取不到就用成分股平均。
        within(cached("sector-board", () => source("sectorBoard")), 15_000)
      ]);
      const boardChange = row => finite(row?.returns?.r1 ?? row?.memberAverageReturn);
      const industries = take(board?.industries, 400).filter(row => row && boardChange(row) !== null).sort((a, b) => boardChange(b) - boardChange(a));
      const officialIndex = industries.findIndex(row => row.name === industry);
      const official = officialIndex >= 0 ? industries[officialIndex] : null;
      if (!detail && !official) throw toolError(`板块「${industry}」行情暂不可用`);
      const members = take(detail?.constituents, 600).filter(item => /^\d{6}$/.test(String(item?.code || "")));
      const quoted = members.filter(item => finite(item.changePct) !== null);
      const sorted = [...quoted].sort((a, b) => b.changePct - a.changePct);
      const position = sorted.findIndex(item => item.code === security.code);
      const memberAverage = quoted.length ? round(quoted.reduce((sum, item) => sum + item.changePct, 0) / quoted.length) : null;
      const officialChange = official ? round(boardChange(official)) : null;
      const indexChange = finite(detail?.returns?.r1);
      // 板块指数的近 5 日只有在它的「最近一日」和今日行业榜一致时才可信。
      const indexCurrent = officialChange === null || (indexChange !== null && Math.abs(indexChange - officialChange) <= 1.5);
      const rising = finite(official?.rising) ?? quoted.filter(item => item.changePct > 0).length;
      const falling = finite(official?.falling) ?? quoted.filter(item => item.changePct < 0).length;
      const data = {
        industry: clip(official?.name || detail?.name || industry, 12),
        changePct: officialChange ?? memberAverage, changeSource: officialChange !== null ? "同花顺行业榜" : "成分股平均",
        memberAverageChangePct: memberAverage, rising, falling, memberCount: finite(official?.memberCount) ?? detail?.memberCount ?? members.length,
        limitUps: finite(official?.poolLimitUps) ?? finite(detail?.limitUps) ?? members.filter(item => item.isLimitUp).length,
        netInflowYi: yi(finite(official?.netInflow)),
        industryRank: official ? `${officialIndex + 1}/${industries.length}` : null,
        ...(indexCurrent && finite(detail?.returns?.r5) !== null ? { return5: round(detail.returns.r5) } : {}),
        rankInSector: position >= 0 ? `${position + 1}/${quoted.length}` : null,
        leaders: sorted.slice(0, 6).map(item => ({ code: item.code, name: clip(item.name, 8), changePct: round(item.changePct), limitUp: item.isLimitUp === true })),
        laggards: sorted.slice(-3).map(item => ({ name: clip(item.name, 8), changePct: round(item.changePct) }))
      };
      return { summary: `${data.industry} 今日 ${data.changePct ?? "--"}%（${data.industryRank ? `行业第 ${data.industryRank}，` : ""}涨 ${rising} 跌 ${falling}），涨停 ${data.limitUps ?? "--"}${data.rankInSector ? `，个股排第 ${data.rankInSector}` : ""}`, data };
    },

    async announcements(args) {
      const security = securityArg(args);
      const rows = await cached(`ann:${security.code}`, () => source("announcements", security.code));
      const list = take(rows, 8).map(item => ({ date: String(item.display_time || item.notice_date || item.date || "").slice(0, 10), title: clip(item.title, 60),
        category: clip(item.category, 10), direction: DIRECTION_LABEL[item.direction] || clip(item.direction, 6) || "中性", risk: finite(item.riskSeverity ?? item.risk) }));
      const negative = list.filter(item => item.direction === "利空" || (item.risk ?? 0) >= 2);
      return { summary: list.length ? `最近 ${list.length} 条公告，最新：${list[0].date} ${clip(list[0].title, 24)}${negative.length ? `；偏利空/有风险 ${negative.length} 条` : ""}` : "最近没有公告",
        data: { code: security.code, announcements: list } };
    },

    async news(args) {
      const security = securityArg(args);
      const name = nameOf(security.code) || security.name;
      const value = await cached(`news:${security.code}`, () => source("news", { code: security.code, name: name === security.code ? "" : name }));
      const items = take(value?.items, 10).map(item => ({ time: beijingTime(item.publishedAt || item.time), title: clip(item.title, 60),
        summary: clip(item.summary, 90), source: clip(item.source || item.sourceName, 10), direction: DIRECTION_LABEL[item.direction] || clip(item.direction, 6) }));
      return { summary: items.length ? `相关资讯 ${items.length} 条，最新：${clip(items[0].title, 28)}` : "最近快讯里没有提到这只股票", data: { code: security.code, items } };
    },

    async market() {
      const [value, board] = await Promise.all([fuyao(), cached("sector-board", () => source("sectorBoard")).catch(() => null)]);
      const industries = take(board?.industries, 300).map(row => ({ name: clip(row.name, 10), changePct: round(finite(row.returns?.r1) ?? finite(row.memberAverageReturn)), limitUps: finite(row.poolLimitUps ?? row.limitUps) }))
        .filter(row => row.changePct !== null).sort((a, b) => b.changePct - a.changePct);
      if (!value && !industries.length) throw toolError("市场数据暂不可用");
      const data = {
        limitUpCount: value?.limitUp?.count ?? null, maxBoards: value?.limitUp?.maxBoards ?? null, limitBreakCount: value?.limitBreak?.count ?? null, limitDownCount: value?.limitDown?.count ?? null,
        sealRatePct: finite(value?.sealRate) === null ? null : Math.round(value.sealRate * 100),
        boardCounts: take(value?.limitUp?.boardCounts, 5).map(item => `${item.label}${item.count}`),
        topReasons: take(value?.limitUp?.reasons, 8).map(item => ({ reason: clip(item.reason, 14), count: item.count })),
        leaders: take(value?.limitUp?.leaders, 6).map(item => ({ name: clip(item.name, 8), boards: finite(item.boards), reason: clip(item.reason, 16) })),
        hot: take(value?.hotLists?.day?.hot || value?.hot, 10).map(item => clip(item.name, 8)),
        strongIndustries: industries.slice(0, 6), weakIndustries: industries.slice(-4)
      };
      return { summary: `涨停 ${data.limitUpCount ?? "--"}，跌停 ${data.limitDownCount ?? "--"}，炸板 ${data.limitBreakCount ?? "--"}，封板率 ${data.sealRatePct ?? "--"}%，最高 ${data.maxBoards ?? "--"} 板`, data };
    },

    async sector_rank(args) {
      const result = await source("reviewSkill", "sector_strength", args || {});
      if (!result?.ok) throw toolError(result?.summary || "板块排行暂不可用");
      return { summary: result.summary, data: result.data };
    }
  };

  /** 执行一个工具；失败时返回错误说明（让 AI 知道这条数据拿不到）。 */
  function runTool(id, rawArgs = {}, { signal } = {}) {
    const tool = TOOL_BY_ID.get(id);
    const args = rawArgs && typeof rawArgs === "object" && !Array.isArray(rawArgs) ? rawArgs : {};
    if (!tool) return Promise.resolve({ tool: String(id).slice(0, 30), name: String(id).slice(0, 30), ok: false, summary: "没有这个工具", data: null, args });
    const limit = id === "diagnosis" || id === "strategies" ? slowToolTimeoutMs : toolTimeoutMs;
    const task = runtime.run("single", `tool:${++sequence}`, { signal, timeoutMs: limit }, async () => {
      runtime.checkpoint();
      const value = await run[id](args);
      runtime.checkpoint();
      return value;
    });
    const result = task.then(value => ({ tool: id, name: tool.name, ok: true, summary: clip(value.summary, 110), data: value.data, args }), error => {
      if (signal?.aborted) throw signal.reason ?? error;
      const message = error?.code === "JOB_TIMEOUT" ? `${tool.name}超过 ${Math.round(limit / 1000)} 秒没返回` : String(error?.message || error).replace(/^\[[A-Z_]+\]\s*/, "");
      return { tool: id, name: tool.name, ok: false, summary: clip(message, 110), data: null, args };
    });
    Object.defineProperty(result, "drained", { value: task.drained });
    return result;
  }

  return { catalog: TOOLS, runTool, remember, shutdown: reason => runtime.shutdown(reason) };
}

module.exports = { createStockAgentTools, toolCatalogText, securityOf, STOCK_AGENT_TOOLS: TOOLS };
