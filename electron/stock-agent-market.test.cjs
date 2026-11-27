"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStockAgentTools, toolCatalogText, securityOf, STOCK_AGENT_TOOLS } = require("./stock-agent-tools.cjs");
const { normalizeFocus, focusPrefetchCalls, systemPrompt, runAgentTurn, isMarketQuestion } = require("./stock-agent.cjs");
const skillLib = require("./stock-agent-skills.cjs");

const rowsRising = Array.from({ length: 70 }, (_, i) => ({ date: `2026-${String(8 + Math.floor(i / 28)).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")}`, close: 3000 + i * 10 }));
const etfs = {
  fetchedAt: "2026-11-20T02:00:00.000Z", highPremiumPercent: 3,
  items: [
    { code: "510300", name: "沪深300ETF华泰柏瑞", secid: "1.510300", category: "宽基", t0: false, amplitude: 1.1, latest: 4.012, changePct: 0.62, amount: 3.1e9, scale: 1.2e11, turnover: 2.6, premiumPct: 0.05, iopv: 4.01 },
    { code: "513310", name: "中韩半导体ETF华泰柏瑞", secid: "1.513310", category: "跨境", t0: true, amplitude: 4.2, latest: 3.513, changePct: -2.69, amount: 4.6e9, scale: 9.4e9, turnover: 49, premiumPct: 9.41, iopv: 3.2108 },
    { code: "512880", name: "证券ETF国泰", secid: "1.512880", category: "行业主题", latest: 1.105, changePct: 3.42, amount: 1.2e9, scale: 3e10, turnover: 4, premiumPct: 0.1, iopv: 1.104 },
    { code: "588170", name: "科创半导体ETF华夏", secid: "1.588170", category: "行业主题", latest: 0.695, changePct: 2.66, amount: 4.5e9, scale: 4.7e10, turnover: 9, premiumPct: -0.35, iopv: 0.6974 }
  ]
};
function sources(overrides = {}) {
  const calls = [];
  const track = (name, value) => (...args) => { calls.push([name, ...args]); return typeof value === "function" ? value(...args) : Promise.resolve(value); };
  return { calls, sources: {
    search: track("search", [{ code: "600519", name: "贵州茅台", assetType: "stock", marketName: "A股" }, { code: "512690", name: "酒ETF", assetType: "etf", marketName: "ETF" }]),
    indexCharts: track("indexCharts", [{ code: "000001", name: "上证指数", rows: rowsRising }, { code: "399006", name: "创业板指", rows: [] }]),
    etfMarket: track("etfMarket", etfs),
    reviewSkill: track("reviewSkill", { ok: true, summary: "PCB：成分 40 只，上涨 28 只，涨停 3 只", data: { name: "PCB", members: 40 } }),
    ...overrides
  } };
}

test("the catalog offers market-wide, sector and ETF tools for the prompt", () => {
  const text = toolCatalogText();
  for (const id of ["index_overview", "sector_detail", "etf_quote", "etf_rank"]) assert.match(text, new RegExp(`- ${id}「`));
});

test("index overview reports level, change, trend versus the 20/60-day lines and says what is missing", async () => {
  const { sources: s } = sources();
  const result = await createStockAgentTools(s).runTool("index_overview", {});
  assert.equal(result.ok, true);
  const sh = result.data.indices.find(item => item.name === "上证指数");
  assert.equal(sh.close, 3690);
  assert.equal(sh.changePct, 0.27);
  assert.equal(sh.return5Pct, 1.37);
  assert.equal(sh.aboveMa20, true);
  assert.equal(sh.aboveMa60, true);
  assert.match(sh.trend, /多头/);
  assert.ok(result.data.missing.includes("创业板指"));
  assert.match(result.summary, /上证指数 3690/);
});

test("sector detail looks up any sector by name through the review skill", async () => {
  const { sources: s, calls } = sources();
  const tools = createStockAgentTools(s);
  const result = await tools.runTool("sector_detail", { name: "PCB" });
  assert.equal(result.ok, true);
  assert.deepEqual(calls.find(call => call[0] === "reviewSkill").slice(1, 3), ["sector_members", { name: "PCB" }]);
  assert.equal((await tools.runTool("sector_detail", {})).ok, false);
});

test("ETF quote finds a fund by code or keyword and warns about a high premium in plain words", async () => {
  const { sources: s } = sources();
  const tools = createStockAgentTools(s);
  const byCode = await tools.runTool("etf_quote", { code: "513310" });
  assert.equal(byCode.ok, true);
  assert.equal(byCode.data.etfs[0].premiumPct, 9.41);
  assert.match(byCode.data.etfs[0].warning, /溢价/);
  assert.match(byCode.summary, /溢价 9\.41%/);
  const byWord = await tools.runTool("etf_quote", { query: "半导体" });
  assert.deepEqual(byWord.data.etfs.map(item => item.code), ["513310", "588170"]);
  assert.equal((await tools.runTool("etf_quote", { query: "不存在的主题" })).ok, false);
});

test("ETF ranking filters by category and sorts by change, turnover or premium", async () => {
  const { sources: s } = sources();
  const tools = createStockAgentTools(s);
  const byChange = await tools.runTool("etf_rank", { category: "行业主题", sortBy: "change", top: 5 });
  assert.deepEqual(byChange.data.etfs.map(item => item.code), ["512880", "588170"]);
  const byPremium = await tools.runTool("etf_rank", { sortBy: "premium", top: 1 });
  assert.deepEqual(byPremium.data.etfs.map(item => item.code), ["513310"]);
});

test("ETF codes resolve to the right exchange and asset type, and search returns ETFs too", async () => {
  assert.deepEqual([securityOf("510300").secid, securityOf("510300").assetType], ["1.510300", "etf"]);
  assert.deepEqual([securityOf("159915").secid, securityOf("159915").assetType], ["0.159915", "etf"]);
  assert.deepEqual([securityOf("600519").secid, securityOf("600519").assetType], ["1.600519", "stock"]);
  assert.deepEqual([securityOf("300750").secid, securityOf("300750").assetType], ["0.300750", "stock"]);
  // 北交所 920 新代码和老代码都走 0. 前缀，不能被 9 开头误判为沪市；900 开头的沪 B 仍为 1.
  assert.deepEqual([securityOf("920118").secid, securityOf("920118").assetType], ["0.920118", "stock"]);
  assert.equal(securityOf("830799").secid, "0.830799");
  assert.equal(securityOf("900901").secid, "1.900901");
  const { sources: s } = sources();
  const found = await createStockAgentTools(s).runTool("search_stock", { query: "酒" });
  assert.deepEqual(found.data.stocks.map(item => item.code), ["600519", "512690"]);
});

test("the question can be about the market, a sector, an ETF or a stock, each with its own first data read", () => {
  assert.deepEqual(normalizeFocus({ code: "600519", name: "贵州茅台" }), { code: "600519", name: "贵州茅台" });
  assert.deepEqual(normalizeFocus({ kind: "etf", code: "510300", name: "沪深300ETF" }), { kind: "etf", code: "510300", name: "沪深300ETF" });
  assert.deepEqual(normalizeFocus({ kind: "sector", name: "PCB" }), { kind: "sector", code: "", name: "PCB" });
  assert.deepEqual(normalizeFocus({ kind: "market" }), { kind: "market", code: "", name: "大盘" });
  assert.equal(normalizeFocus({ kind: "sector", name: "" }), null);
  assert.equal(normalizeFocus({ kind: "etf", code: "abc" }), null);
  const tools = focus => focusPrefetchCalls(focus).map(call => `${call.tool}:${JSON.stringify(call.args)}`);
  assert.deepEqual(tools({ kind: "market", code: "", name: "大盘" }), ['index_overview:{}', 'market:{}', 'sector_rank:{"kind":"industry","sortBy":"change","top":10}', 'global_markets:{}', 'global_news:{}', 'market_news:{}']);
  assert.deepEqual(tools({ kind: "sector", code: "", name: "PCB" }), ['sector_detail:{"name":"PCB"}', 'market:{}']);
  assert.deepEqual(tools({ kind: "etf", code: "510300", name: "沪深300ETF" }), ['etf_quote:{"code":"510300"}', 'kline:{"code":"510300","days":30}', 'index_overview:{}']);
  assert.ok(tools({ code: "600519", name: "贵州茅台" }).includes('quote:{"code":"600519"}'));
});

test("six market-level skills exist, use real tools and read data that fits the chosen target", () => {
  const toolIds = new Set(STOCK_AGENT_TOOLS.map(tool => tool.id));
  const ids = ["market_regime", "sentiment_cycle", "mainline", "etf_pick", "index_timing", "style_rotation"];
  for (const id of ids) {
    const skill = skillLib.BUILTIN_SKILLS.find(item => item.id === id);
    assert.ok(skill, id);
    assert.equal(skill.group, "大盘与ETF");
    for (const spec of skill.tools) assert.ok(toolIds.has(skillLib.parseToolSpec(spec).tool), `${id}: ${spec}`);
  }
  const market = skillLib.skillPrefetchCalls(skillLib.resolveSkills(["market_regime"]), { kind: "market", code: "", name: "大盘" });
  assert.deepEqual(market.map(call => call.tool), ["index_overview", "market", "sector_rank", "global_markets", "global_news"]);
  const etf = skillLib.skillPrefetchCalls(skillLib.resolveSkills(["etf_pick"]), { kind: "etf", code: "513310", name: "中韩半导体ETF" });
  assert.deepEqual(etf.find(call => call.tool === "etf_quote").args, { code: "513310" });
  const stockOnly = skillLib.skillPrefetchCalls(skillLib.resolveSkills(["relay_board"]), { kind: "market", code: "", name: "大盘" });
  assert.ok(!stockOnly.some(call => call.args.code === ""), "stock-only tools are not called with an empty code");
});

test("every answer states a stance, key levels and what would prove it wrong", () => {
  const prompt = systemPrompt({ clock: { text: "2026-11-20 10:00 星期五", session: "盘中（上午）" }, memory: "" });
  assert.match(prompt, /个股、ETF、板块和大盘/);
  assert.match(prompt, /失效条件/);
  const skilled = skillLib.skillPromptText(skillLib.resolveSkills(["trend_follow"]));
  assert.match(skilled, /失效条件/);
});

test("ETF ranking supports a T+0 board and tells the model which funds can be round-tripped intraday", async () => {
  const { sources: s } = sources();
  const tools = createStockAgentTools(s);
  const t0 = await tools.runTool("etf_rank", { category: "T+0", sortBy: "amplitude", top: 5 });
  assert.equal(t0.ok, true);
  assert.deepEqual(t0.data.etfs.map(item => item.code), ["513310"]);
  assert.equal(t0.data.category, "T+0");
  assert.match(t0.data.etfs[0].tradingRule, /T\+0/);
  assert.equal(t0.data.etfs[0].amplitudePct, 4.2);
  const quote = await tools.runTool("etf_quote", { code: "510300" });
  assert.match(quote.data.etfs[0].tradingRule, /T\+1/);
});

const globalQuotes = {
  fetchedAt: "2026-11-24T01:30:00.000Z", summary: "美股 道琼斯-0.85%、标普500-1.12%、纳斯达克-1.60%；亚太 日经225+0.40%；A50期指-0.30%",
  quotes: [
    { group: "美股", name: "道琼斯", code: "DJIA", latest: 44210.5, changePct: -0.85, time: "11-24 05:00" },
    { group: "亚太", name: "韩国KOSPI", code: "KS11", latest: null, changePct: null, time: "" },
    { group: "A50", name: "富时A50期指", code: "CN00Y", latest: 13500, changePct: -0.3, time: "11-24 08:30" }
  ],
  missing: ["韩国KOSPI"], note: "美股为隔夜收盘"
};
const globalNews = {
  items: [
    { title: "美股收盘：纳指跌1.6%", summary: "", time: "11-24 05:02", category: "overseasMarket", categoryLabel: "外围市场", source: "东方财富7×24" },
    { title: "彭博：高盛上调中国股市评级", summary: "看好A股", time: "11-24 08:10", category: "aShareView", categoryLabel: "对A股的研判", source: "财联社电报" },
    { title: "原油跌2%", summary: "", time: "11-24 04:40", category: "commodity", categoryLabel: "大宗商品", source: "财联社电报" }
  ],
  byCategory: { overseasMarket: 1, aShareView: 1, commodity: 1 }, windowHours: 18, note: "外媒原文多为付费内容"
};

test("global markets and overseas news tools give the model numbers with times and A-share views first, never zero-filled", async () => {
  let newsReads = 0;
  const { sources: s } = sources({ globalMarkets: () => Promise.resolve(globalQuotes), globalNews: () => { newsReads += 1; return Promise.resolve(globalNews); } });
  const tools = createStockAgentTools(s);
  const markets = await tools.runTool("global_markets", {});
  assert.equal(markets.ok, true);
  assert.match(markets.summary, /纳斯达克-1\.60%/);
  assert.deepEqual(markets.data.quotes.map(item => item.name), ["道琼斯", "富时A50期指"], "a quote without a price is left out, not shown as 0");
  assert.deepEqual(markets.data.missing, ["韩国KOSPI"]);
  assert.equal(markets.data.quotes[0].time, "11-24 05:00");
  const news = await tools.runTool("global_news", { hours: 99 });
  assert.equal(news.ok, true);
  assert.equal(news.data.windowHours, 36, "hours are clamped");
  assert.equal(news.data.items[0].category, "对A股的研判");
  assert.match(news.summary, /A股研判 1/);
  assert.match(news.data.note, /付费/);
  const only = await tools.runTool("global_news", { hours: 36, category: "commodity" });
  assert.deepEqual(only.data.items.map(item => item.title), ["原油跌2%"]);
  assert.match(only.summary, /外围资讯 1 条（A股研判 0、外媒机构 0、外围市场 0、海外宏观 0）/);
  assert.equal(newsReads, 1, "same window is served from the 2-minute cache");
  const missing = await createStockAgentTools(sources().sources).runTool("global_markets", {});
  assert.equal(missing.ok, false);
});

test("domestic headlines and short-term market skills are callable tools", async () => {
  const feed = { items: [
    { title: "国务院常务会议部署扩大内需", summary: "", eventType: "政策", importanceScore: 86, direction: "positive", publishedAt: "2026-11-24T00:30:00.000Z" },
    { title: "某公司股东减持", summary: "", eventType: "快讯", importanceScore: 40, direction: "negative", publishedAt: "2026-11-24T00:40:00.000Z" },
    { title: "沪指高开0.2%", summary: "", eventType: "市场", importanceScore: 50, direction: "neutral", publishedAt: "2026-11-24T01:31:00.000Z" }
  ] };
  const { sources: s, calls } = sources({ marketNews: () => Promise.resolve(feed) });
  const tools = createStockAgentTools(s);
  const news = await tools.runTool("market_news", {});
  assert.deepEqual(news.data.items.map(item => item.title), ["国务院常务会议部署扩大内需", "沪指高开0.2%"]);
  assert.equal(news.data.items[0].direction, "利好");
  for (const id of ["limit_reasons", "ladder", "broken_boards", "hot_stocks", "dragon_tiger", "anomalies"]) {
    const result = await tools.runTool(id, { top: 99, period: "hour" });
    assert.equal(result.ok, true, id);
  }
  const forwarded = calls.filter(call => call[0] === "reviewSkill").map(call => [call[1], call[2]]);
  assert.deepEqual(forwarded.find(([skill]) => skill === "limit_reasons")[1], { top: 20 });
  assert.deepEqual(forwarded.find(([skill]) => skill === "hot_stocks")[1], { period: "hour" });
});

test("asking how the market will go without a focus reads A-share and global data first and the prompt demands an overseas section", async () => {
  assert.ok(isMarketQuestion("今天大盘怎么走"));
  assert.ok(isMarketQuestion("隔夜美股大跌对A股影响大吗"));
  assert.ok(isMarketQuestion("日韩股市今天怎么样"));
  assert.ok(!isMarketQuestion("贵州茅台能买吗"));
  const { sources: s } = sources({ globalMarkets: () => Promise.resolve(globalQuotes), globalNews: () => Promise.resolve(globalNews), marketNews: () => Promise.resolve({ items: [] }) });
  const tools = createStockAgentTools(s);
  const seen = [];
  const ai = { model: () => "fake", chat: async request => { seen.push(request); return { thought: "够了", final: { answer: "**均衡**\n\n### 外围与外媒\n纳指-1.6%", stance: "中性", confidence: "中", focus: { kind: "market", name: "大盘" }, followUps: [] } }; } };
  const result = await runAgentTurn({ ai, tools, question: "今天大盘怎么走", focus: null, prefetch: false, marketIntent: true, clock: { text: "2026-11-24 09:00 星期二", session: "盘前" } });
  assert.equal(result.steps[0].kind, "prefetch");
  assert.deepEqual(result.steps[0].calls.map(call => call.tool), ["index_overview", "market", "sector_rank", "global_markets", "global_news", "market_news"]);
  assert.match(seen[0].system, /global_markets/);
  assert.match(seen[0].system, /外围与外媒/);
  assert.match(seen[0].system, /彭博/);
  assert.match(seen[0].messages.at(-1).content, /纳斯达克/);
  const plain = await runAgentTurn({ ai, tools, question: "随便聊聊", focus: null, prefetch: false, clock: { text: "2026-11-24 09:00 星期二", session: "盘前" } });
  assert.ok(!plain.steps.some(step => step.kind === "prefetch"));
});

test("new market skills use real tools and pre-read global data", () => {
  const toolIds = new Set(STOCK_AGENT_TOOLS.map(tool => tool.id));
  for (const id of ["global_premarket", "fx_foreign", "policy_news", "theme_ladder", "hot_money"]) {
    const skill = skillLib.BUILTIN_SKILLS.find(item => item.id === id);
    assert.ok(skill, id);
    assert.ok(skillLib.SKILL_GROUPS.includes(skill.group), id);
    for (const spec of skill.tools) assert.ok(toolIds.has(skillLib.parseToolSpec(spec).tool), `${id}: ${spec}`);
  }
  const premarket = skillLib.skillPrefetchCalls(skillLib.resolveSkills(["global_premarket"]), null);
  assert.deepEqual(premarket.map(call => call.tool), ["global_markets", "global_news", "index_overview", "market_news", "market"]);
});

test("fundamentals-based and structure skills use real tools; the prompt asks for a risk review that can veto", () => {
  const toolIds = new Set(STOCK_AGENT_TOOLS.map(tool => tool.id));
  assert.ok(toolIds.has("fundamentals"));
  for (const id of ["growth_quality", "expectation_repricing", "chan_theory", "wave_theory"]) {
    const skill = skillLib.BUILTIN_SKILLS.find(item => item.id === id);
    assert.ok(skill, id);
    assert.ok(skillLib.SKILL_GROUPS.includes(skill.group), id);
    for (const spec of skill.tools) assert.ok(toolIds.has(skillLib.parseToolSpec(spec).tool), `${id}: ${spec}`);
  }
  const prompt = systemPrompt({ clock: { text: "2026-11-27 10:00 星期五", session: "盘中（上午）" }, memory: "" });
  assert.match(prompt, /"riskReview":\{"verdict":"pass\|downgrade\|veto"/);
  assert.match(prompt, /veto 时软件会把买入\/加仓记成观望/);
});
