"use strict";
// AI 问股（1.6.53）：对话式个股分析的工具、问答循环与对话管理。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStockAgentTools, toolCatalogText } = require("./stock-agent-tools.cjs");
const { createStockAgentService, runAgentTurn, validateFinal, fitJson, systemPrompt, MAX_TOOL_ROUNDS, PREFETCH_TOOLS } = require("./stock-agent.cjs");

const clock = { text: "2026-11-06 10:49 星期五", session: "盘中（上午）" };
const profile = { code: "600519", name: "贵州茅台", industry: "白酒", asOfDate: "2026-11-05", bars: 120, latest: 1500, changePct: 1.2, return5: 2, return20: -3, return60: 5,
  ma: { ma5: 1490, ma10: 1480, ma20: 1510, ma60: 1450 }, alignment: "均线交织", trend: "站上5日/10日/60日线，20日线下方", volumeRatio: 1.3, amountYi: 50, avgAmount20Yi: 45,
  consecutiveBoards: 0, limitUps20: 0, broken20: 0, lastLimitDate: "", daysSinceLimit: null, high20: 1560, low20: 1460, high60: 1600, low60: 1400,
  macd: { dif: 1, dea: 0.5, hist: 1, histTrend: "放大", cross: "金叉", crossDays: 1 }, rsi6: 55, rsi14: 52, bias5: 0.7, gaps: [],
  support: [{ label: "5日线", price: 1490 }], resistance: [{ label: "20日线", price: 1510 }], announcements: [], announcementsAvailable: true };
const fuyao = { available: true, fetchedAt: "2026-11-06T02:40:00.000Z",
  limitUp: { count: 50, maxBoards: 5, boardCounts: [], reasons: [{ reason: "光伏", count: 6 }], leaders: [], byCode: { "601001": { name: "甲", reason: "光伏+储能", boards: 3, boardsText: "3天3板", sealMoney: 2e8, limitUpTime: "09:31:00" } } },
  limitBreak: { count: 8, top: [], byCode: { "601002": { name: "乙", changePct: 6.1, openTimes: 3 } } },
  limitDown: { count: 2, top: [], byCode: {} }, sealRate: 0.86,
  hotLists: { day: { hot: [{ code: "601001", name: "甲", rank: 4 }], skyrocket: [] }, hour: { hot: [], skyrocket: [] } },
  dragonTiger: { date: "2026-11-05", byCode: { "601001": { name: "甲", changePct: 10, net: 1.2e8, buy: 3e8, sell: 1.8e8, orgNet: 5e7, hotMoneyNet: 7e7, reason: "日涨幅偏离7%", concepts: ["光伏"], desks: ["某游资"] } } },
  ladder: { days: [{ date: "2026-11-05", tiers: [{ label: "2板", stocks: [{ code: "601001", name: "甲", nextDay: "晋级" }] }] }] },
  anomalies: [{ code: "601001", name: "甲", tag: "涨停", content: "光伏储能订单落地", keywords: ["储能"] }] };

function fakeSources(overrides = {}) {
  const calls = [];
  const track = (name, value) => (...args) => { calls.push([name, ...args]); return typeof value === "function" ? value(...args) : Promise.resolve(value); };
  return { calls, sources: {
    search: track("search", [{ code: "600519", name: "贵州茅台", assetType: "stock", marketName: "A股" }, { code: "512690", name: "酒ETF", assetType: "etf" }]),
    quote: track("quote", { quote: { name: "贵州茅台", latest: 1500, changePct: 1.2, open: 1490, high: 1510, low: 1485, preClose: 1482, amount: 5e9, turnover: 0.4, amplitude: 1.7,
      limitUp: 1630.2, limitDown: 1333.8, totalMarketCap: 1.88e12, floatMarketCap: 1.88e12, industry: "白酒", quoteAt: "2026-11-06T02:48:00.000Z" } }),
    profile: track("profile", profile),
    dailyRows: track("dailyRows", Array.from({ length: 30 }, (_, i) => ({ date: `2026-10-${String(i + 1).padStart(2, "0")}`, open: 10 + i, high: 11 + i, low: 9 + i, close: 10.5 + i, amount: 1e8, turnover: 2 }))),
    timeShare: track("timeShare", { preClose: 10, tradingDate: "2026-11-06", rows: [
      { date: "2026-11-06 09:31", close: 10.1, average: 10.1, amount: 1e7 }, { date: "2026-11-06 10:00", close: 10.6, average: 10.3, amount: 2e7 },
      { date: "2026-11-06 10:30", close: 10.4, average: 10.35, amount: 1e7 }] }),
    announcements: track("announcements", [{ notice_date: "2026-11-04", title: "关于回购股份的公告", direction: "positive", riskSeverity: 0, category: "回购" }]),
    news: track("news", { items: [{ publishedAt: "2026-11-06T02:00:00.000Z", title: "白酒板块走强", summary: "…", source: "财联社", direction: "positive" }] }),
    industry: track("industry", "白酒"),
    sectorDetail: track("sectorDetail", { name: "白酒", memberCount: 3, returns: { r1: 1.1, r5: 3 }, limitUps: 0, constituents: [
      { code: "000858", name: "五粮液", changePct: 2 }, { code: "600519", name: "贵州茅台", changePct: 1.2 }, { code: "000568", name: "泸州老窖", changePct: -0.5 }] }),
    fuyao: track("fuyao", fuyao),
    marketContext: value => ({ limitUpCount: value?.limitUp?.count ?? null }),
    score: () => ({ name: "自动编排", base: 62, dims: [{ label: "趋势", weight: 30, score: 70, note: "均线交织" }], caps: [] }),
    situationOf: () => ["趋势中继"],
    strategies: track("strategies", { asOfDate: "2026-11-05", evaluated: true, activeCount: 19, featuredCount: 7,
      hits: [{ name: "涨停高开支撑守卫", featured: true, reasons: ["涨停后高开"], invalidationPrice: 9.8, notes: [] }] }),
    diagnosis: track("diagnosis", { analysis: { grade: "B", mrs: 66, actionSignal: "OBSERVE", tradePlan: { stopLossPrice: 1450, stopLossDistancePercent: 3.3, takeProfitPrice: 1580 }, strategyResults: [], risks: ["量能偏弱"] } }),
    sectorBoard: track("sectorBoard", { industries: [{ name: "白酒", returns: { r1: 1.1 } }, { name: "煤炭", returns: { r1: -2 } }] }),
    reviewSkill: track("reviewSkill", { ok: true, summary: "行业按涨幅前列：白酒", data: { top: [] } }),
    ...overrides
  } };
}

test("the tool catalog lists every data tool for the prompt and unknown tools fail softly", async () => {
  const text = toolCatalogText();
  for (const id of ["search_stock", "quote", "profile", "kline", "intraday", "strategies", "score", "diagnosis", "limit_status", "sector", "announcements", "news", "market", "sector_rank"]) assert.match(text, new RegExp(`- ${id}「`));
  const { sources } = fakeSources();
  const tools = createStockAgentTools(sources);
  const missing = await tools.runTool("buy_stock", { code: "600519" });
  assert.equal(missing.ok, false);
  const bad = await tools.runTool("quote", { code: "abc" });
  assert.equal(bad.ok, false);
  assert.match(bad.summary, /6 位股票代码/);
});

test("stock tools return compact facts with one-line summaries and reuse results for two minutes", async () => {
  let clockMs = 0;
  const { sources, calls } = fakeSources();
  const tools = createStockAgentTools(sources, { now: () => clockMs });
  const search = await tools.runTool("search_stock", { query: "茅台" });
  assert.deepEqual(search.data.stocks.map(item => item.code), ["600519"], "ETFs are not offered as stocks");
  const quote = await tools.runTool("quote", { code: "600519" });
  assert.equal(quote.ok, true);
  assert.equal(quote.data.amountYi, 50);
  assert.equal(quote.data.totalMarketCapYi, 18800);
  assert.match(quote.summary, /贵州茅台 现价 1500/);
  const again = await tools.runTool("quote", { code: "600519" });
  assert.equal(again.data.latest, 1500);
  assert.equal(calls.filter(call => call[0] === "quote").length, 1, "cached within two minutes");
  clockMs += 3 * 60 * 1000;
  await tools.runTool("quote", { code: "600519" });
  assert.equal(calls.filter(call => call[0] === "quote").length, 2, "refetched after the cache expires");

  const health = await tools.runTool("profile", { code: "600519" });
  assert.match(health.summary, /支撑 1490\(5日线\)/);
  assert.deepEqual(health.data.situation, ["趋势中继"]);
  const kline = await tools.runTool("kline", { code: "600519", days: 5 });
  assert.equal(kline.data.bars.length, 5);
  assert.equal(kline.data.bars.at(-1).date, "2026-10-30");
  assert.equal(kline.data.bars.at(-1).amountYi, 1);
  const intraday = await tools.runTool("intraday", { code: "600519" });
  assert.equal(intraday.data.high.time, "10:00");
  assert.equal(intraday.data.high.pct, 6);
  assert.equal(intraday.data.latestVsAveragePct, 0.48);
  const sector = await tools.runTool("sector", { code: "600519" });
  assert.equal(sector.data.rankInSector, "2/3");
  assert.deepEqual([sector.data.changePct, sector.data.changeSource, sector.data.industryRank, sector.data.rising, sector.data.falling], [1.1, "同花顺行业榜", "1/2", 2, 1]);
  assert.equal(sector.data.return5, 3, "the index's 5-day change is kept when its last day matches today's ranking");
  const notices = await tools.runTool("announcements", { code: "600519" });
  assert.equal(notices.data.announcements[0].direction, "利好");
  const news = await tools.runTool("news", { code: "600519" });
  assert.equal(news.data.items[0].time, "11-06 10:00", "news time is shown in Beijing time");
  const strategies = await tools.runTool("strategies", { code: "600519" });
  assert.match(strategies.summary, /命中 1 条：涨停高开支撑守卫\(精选\)/);
  const score = await tools.runTool("score", { code: "600519" });
  assert.equal(score.data.base, 62);
  const diagnosis = await tools.runTool("diagnosis", { code: "600519" });
  assert.match(diagnosis.summary, /软件评级 B（66 分），信号「观察」，ATR 止损 1450/);
  const market = await tools.runTool("market", {});
  assert.equal(market.data.sealRatePct, 86);
  assert.equal(market.data.strongIndustries[0].name, "白酒");
});

test("sector: today's change comes from the industry ranking, not a stale sector-index bar", async () => {
  // 实机 2026-11-06：「电池」板块指数日线给出 +3.78%，但成分股 107 只里只有 3 只上涨；行业榜当天是 -1.9%。
  const { sources } = fakeSources({
    industry: async () => "电池",
    sectorDetail: async () => ({ name: "电池", memberCount: 4, returns: { r1: 3.78, r5: 9 }, constituents: [
      { code: "300750", name: "宁德时代", changePct: -3.73 }, { code: "300014", name: "亿纬锂能", changePct: 0.5 }, { code: "002074", name: "国轩高科", changePct: -2.1 }, { code: "300438", name: "鹏辉能源", changePct: -1 }] }),
    sectorBoard: async () => ({ industries: [{ name: "银行", returns: { r1: 0.99 } }, { name: "电池", returns: { r1: -1.9 }, rising: 3, falling: 104, memberCount: 107, netInflow: -12.5e8, poolLimitUps: 0 }] })
  });
  const tools = createStockAgentTools(sources);
  const result = await tools.runTool("sector", { code: "300750" });
  assert.equal(result.ok, true);
  assert.deepEqual([result.data.changePct, result.data.industryRank, result.data.rising, result.data.falling, result.data.netInflowYi], [-1.9, "2/2", 3, 104, -12.5]);
  assert.equal(result.data.return5, undefined, "the stale index's 5-day change is dropped");
  assert.equal(result.data.rankInSector, "4/4");
  assert.match(result.summary, /电池 今日 -1.9%（行业第 2\/2，涨 3 跌 104）/);
  const memberOnly = createStockAgentTools(fakeSources({ industry: async () => "电池", sectorBoard: async () => { throw new Error("榜单失败"); },
    sectorDetail: async () => ({ name: "电池", returns: { r1: 3.78 }, constituents: [{ code: "300750", name: "宁德时代", changePct: -3 }, { code: "300014", name: "亿纬锂能", changePct: 1 }] }) }).sources);
  const fallback = await memberOnly.runTool("sector", { code: "300750" });
  assert.deepEqual([fallback.data.changePct, fallback.data.changeSource], [-1, "成分股平均"]);
});

test("limit_status finds a stock in the limit-up pool, hot list, dragon-tiger list, ladder and anomalies", async () => {
  const { sources } = fakeSources();
  const tools = createStockAgentTools(sources);
  const hit = await tools.runTool("limit_status", { code: "601001" });
  assert.equal(hit.ok, true);
  assert.equal(hit.data.limitUp.boards, 3);
  assert.equal(hit.data.limitUp.sealYi, 2);
  assert.equal(hit.data.hotRank.day, 4);
  assert.equal(hit.data.dragonTiger.netYi, 1.2);
  assert.deepEqual(hit.data.dragonTiger.desks, ["某游资"]);
  assert.equal(hit.data.ladder[0].level, "2板");
  assert.match(hit.summary, /^最近交易日数据（\d{4}-\d{2}-\d{2} 取数），涨停（3天3板，光伏\+储能）/);
  const broken = await tools.runTool("limit_status", { code: "601002" });
  assert.match(broken.summary, /炸板（开板 3 次）/);
  const none = await tools.runTool("limit_status", { code: "600519" });
  assert.match(none.summary, /不在涨停\/炸板\/跌停池/);
  const offline = createStockAgentTools(fakeSources({ fuyao: () => Promise.resolve({ available: false }) }).sources);
  const unavailable = await offline.runTool("limit_status", { code: "601001" });
  assert.equal(unavailable.ok, false);
  assert.match(unavailable.summary, /扶摇短线数据暂不可用/);
});

/** 按顺序返回预设回复的假模型；记录每次收到的消息。 */
function scriptedAi(replies) {
  const seen = [];
  return { seen, model: () => "fake-model", async chat(request) {
    seen.push({ ...request, ...(request.messages ? { messages: [...request.messages] } : {}) });
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return typeof next === "function" ? next(request) : next;
  } };
}

test("an agent turn prefetches the focus stock, lets the model call tools, then validates the final answer", async () => {
  const { sources } = fakeSources();
  const tools = createStockAgentTools(sources);
  const ai = scriptedAi([
    { thought: "看K线和分时", calls: [{ tool: "kline", args: { code: "600519", days: 20 } }, { tool: "intraday", args: { code: "600519" } }, { tool: "quote", args: { code: "600519" } }] },
    { thought: "够了", final: { answer: "**结论：震荡偏多**\n\n### 关键价位\n| 类型 | 价位 |\n|---|---|\n| 支撑 | 1490 |", stance: "看多", confidence: "高",
      focus: { code: "600519", name: "贵州茅台" }, followUps: ["明天怎么操作？", "和五粮液比呢？", "", "多余的第四个"] } }
  ]);
  const progress = [];
  const result = await runAgentTurn({ ai, tools, question: "全面分析", focus: { code: "600519", name: "贵州茅台" }, prefetch: true, clock, onSteps: steps => progress.push(steps) });
  assert.equal(result.stance, "不适用", "unknown stances are replaced");
  assert.equal(result.confidence, "高");
  assert.deepEqual(result.followUps, ["明天怎么操作？", "和五粮液比呢？", "多余的第四个"]);
  assert.equal(result.steps[0].kind, "prefetch");
  assert.deepEqual(result.steps[0].calls.map(call => [call.tool, call.status]), PREFETCH_TOOLS.map(tool => [tool, "ok"]));
  assert.deepEqual(PREFETCH_TOOLS, ["quote", "profile", "limit_status", "sector", "announcements", "strategies", "score"]);
  assert.deepEqual(result.steps[1].calls.map(call => call.tool), ["kline", "intraday"], "a call already made in this turn is not repeated");
  assert.equal(result.steps.at(-1).kind, "answer");
  assert.ok(progress.some(steps => steps.some(step => step.calls.some(call => call.status === "running"))), "the page sees running calls");
  const first = JSON.parse(ai.seen[0].messages.at(-1).content);
  assert.equal(first.question, "全面分析");
  assert.deepEqual(first.initialData.map(item => item.tool), PREFETCH_TOOLS);
  assert.match(ai.seen[0].system, /initialData 里，不要重复查/);
  assert.match(ai.seen[0].system, /北京时间 2026-11-06 10:49 星期五（盘中（上午））/);
  const second = JSON.parse(ai.seen[1].messages.at(-1).content);
  assert.deepEqual(second.toolResults.map(item => item.tool), ["kline", "intraday"]);
  assert.equal(second.remainingRounds, MAX_TOOL_ROUNDS - 1);
});

test("an agent turn falls back to a plain answer when the model ignores the JSON protocol or never concludes", async () => {
  const { sources } = fakeSources();
  const tools = createStockAgentTools(sources);
  const badJson = Object.assign(new Error("AI 返回的内容不是有效的 JSON"), { code: "AI_BAD_JSON" });
  const ai = scriptedAi([badJson, request => { assert.equal(request.json, false); return "**结论：观望**\n数据一般。"; }]);
  const result = await runAgentTurn({ ai, tools, question: "茅台怎么样", focus: { code: "600519", name: "贵州茅台" }, prefetch: true, clock });
  assert.equal(result.fallback, true);
  assert.match(result.answer, /结论：观望/);
  const plain = JSON.parse(ai.seen[1].user);
  assert.deepEqual(plain.toolResults.map(item => item.tool), PREFETCH_TOOLS, "the fallback answer still sees the prefetched data");

  const looping = scriptedAi([
    ...Array.from({ length: MAX_TOOL_ROUNDS + 1 }, (_, round) => ({ thought: `第${round}轮`, calls: [{ tool: "kline", args: { code: "600519", days: 5 + round } }] })),
    "**结论：中性**"
  ]);
  const forced = await runAgentTurn({ ai: looping, tools, question: "看K线", focus: null, clock });
  assert.equal(forced.fallback, true);
  assert.equal(forced.steps.length, MAX_TOOL_ROUNDS);
  assert.match(JSON.parse(looping.seen[MAX_TOOL_ROUNDS].messages.at(-1).content).instruction, /必须输出 final/);
});

test("a slow turn stops querying after five minutes and asks the model to wrap up with what it has", async () => {
  const { TURN_WRAP_UP_MS } = require("./stock-agent.cjs");
  const { sources } = fakeSources();
  let clockMs = 0;
  const ai = scriptedAi([
    () => { clockMs += 60_000; return { thought: "看K线", calls: [{ tool: "kline", args: { code: "600519", days: 10 } }] }; },
    () => { clockMs += TURN_WRAP_UP_MS; return { thought: "再看分时", calls: [{ tool: "intraday", args: { code: "600519" } }] }; },
    request => { assert.match(JSON.parse(request.messages.at(-1).content).instruction, /不再查询新数据/); return { final: { answer: "**结论：中性**", stance: "中性" } }; }
  ]);
  const result = await runAgentTurn({ ai, tools: createStockAgentTools(sources), question: "看看", focus: null, clock, now: () => clockMs });
  assert.equal(result.stance, "中性");
  assert.deepEqual(result.steps.flatMap(step => step.calls.map(call => call.tool)), ["kline"], "no new query after the time limit");
});

test("final answers are validated and long tool data is shrunk to fit", () => {
  assert.equal(validateFinal({ final: { answer: "  " } }), null);
  assert.deepEqual(validateFinal({ answer: "直接给的正文", stance: "偏空" }).stance, "偏空");
  assert.equal(validateFinal({ final: { answer: "x", focus: { code: "60051", name: "坏代码" } } }).focus, null);
  const text = fitJson({ rows: Array.from({ length: 500 }, (_, i) => ({ i, note: "很长的说明".repeat(30) })) }, 6000);
  assert.ok(text.length <= 6100);
  assert.doesNotThrow(() => JSON.parse(text));
  assert.match(systemPrompt({ clock, memory: "我做短线，止损 5%" }), /我做短线，止损 5%/);
  assert.doesNotMatch(systemPrompt({ clock, memory: "" }), /个人偏好/);
});

function memoryStore(initial = null) {
  let value = initial;
  return { get value() { return value; }, read: () => value && structuredClone(value), write: next => { value = structuredClone(next); return value; } };
}
const until = async (check, limit = 200) => { for (let i = 0; i < limit; i += 1) { const value = check(); if (value) return value; await new Promise(resolve => setImmediate(resolve)); } throw new Error("timed out"); };

function serviceWith(replies, { store = memoryStore(), config = { id: "p1", name: "DeepSeek", baseUrl: "https://api.example.com/v1", model: "deepseek-chat", apiKey: "k" } } = {}) {
  const { sources, calls } = fakeSources();
  let n = 0;
  const ai = scriptedAi(replies);
  const service = createStockAgentService({
    clientFor: () => ai, resolveProfile: id => (!id || id === config.id ? config : null),
    listProfiles: () => ({ activeId: config.id, profiles: [{ id: config.id, name: config.name, model: config.model }] }),
    tools: createStockAgentTools(sources), store, clock: () => clock, now: () => 1_000_000 + n * 1000, id: () => `id${++n}`
  });
  return { service, ai, store, calls };
}

test("the agent service runs a turn in the background, reports progress and keeps the conversation on disk", async () => {
  const { service, ai, store } = serviceWith([
    { thought: "看K线", calls: [{ tool: "kline", args: { code: "600519", days: 20 } }] },
    { final: { answer: "**结论：偏多**", stance: "偏多", confidence: "中", followUps: ["明天怎么做？"] } },
    // 追问：不再预取，直接回答。
    { final: { answer: "支撑看 1490。", stance: "偏多", confidence: "中" } }
  ]);
  assert.equal(service.state().configured, true);
  assert.equal(service.state().model, "deepseek-chat");
  const { runId, conversationId } = service.start({ message: "全面分析一下", focus: { code: "600519", name: "贵州茅台" } });
  assert.equal(service.poll(runId).status, "running");
  const done = await until(() => { const snap = service.poll(runId); return snap.status !== "running" && snap; });
  assert.equal(done.status, "done");
  assert.equal(done.message.stance, "偏多");
  assert.deepEqual(done.message.steps.map(step => step.kind), ["prefetch", "tools"]);
  const saved = store.value.conversations[0];
  assert.equal(saved.title, "贵州茅台 · 全面分析一下");
  assert.deepEqual(saved.messages.map(item => item.role), ["user", "assistant"]);
  assert.equal(service.state().conversations[0].stance, "偏多");

  const follow = service.start({ conversationId, message: "支撑在哪？", focus: { code: "600519", name: "贵州茅台" } });
  await until(() => service.poll(follow.runId).status === "done");
  const request = ai.seen.at(-1);
  assert.deepEqual(request.messages.slice(0, 2).map(item => item.role), ["user", "assistant"], "earlier turns travel as history");
  assert.match(request.messages[0].content, /当时关注：贵州茅台 600519/);
  assert.equal(JSON.parse(request.messages.at(-1).content).initialData, undefined, "the same stock is not prefetched twice in one conversation");
  assert.equal(service.conversation(conversationId).messages.length, 4);
});

test("failures and stops are recorded in the conversation and not replayed as history", async () => {
  const failure = Object.assign(new Error("AI 接口限流或额度已用完，请稍后再试（HTTP 429）"), { code: "AI_HTTP" });
  const { service, ai } = serviceWith([failure, new Promise(() => {}), { final: { answer: "好的", stance: "中性" } }]);
  const first = service.start({ message: "茅台呢", focus: null });
  const failed = await until(() => { const snap = service.poll(first.runId); return snap.status !== "running" && snap; });
  assert.equal(failed.status, "error");
  assert.match(failed.error, /HTTP 429/);
  assert.equal(service.conversation(first.conversationId).messages.at(-1).error, true);

  ai.chat = (request) => new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason)));
  const second = service.start({ conversationId: first.conversationId, message: "再试一次" });
  assert.throws(() => service.start({ conversationId: first.conversationId, message: "第三次" }), /还在分析中/);
  service.cancel(second.runId);
  const stopped = await until(() => { const snap = service.poll(second.runId); return snap.status !== "running" && snap; });
  assert.equal(stopped.status, "cancelled");
  assert.equal(service.conversation(first.conversationId).messages.at(-1).content, "已停止。");

  const seen = [];
  ai.chat = async request => { seen.push(request); return { final: { answer: "好的", stance: "中性" } }; };
  const third = service.start({ conversationId: first.conversationId, message: "最后一次" });
  await until(() => service.poll(third.runId).status === "done");
  assert.equal(seen[0].messages.length, 1, "failed and stopped questions are not sent as history");

  // 推理模型超时：说清楚是模型没回应，并给出可做的事。
  ai.chat = async () => { throw Object.assign(new Error("AI 接口连接失败：请求超时（240 秒）"), { code: "AI_HTTP" }); };
  const fourth = service.start({ conversationId: first.conversationId, message: "超时那次" });
  const slow = await until(() => { const snap = service.poll(fourth.runId); return snap.status !== "running" && snap; });
  assert.match(slow.error, /模型 240 秒内没有回应.*重试.*换一个响应更快的模型/);
});

test("settings keep the analysis preference and model choice; deleting a conversation removes it", async () => {
  const { service, ai, store } = serviceWith([{ final: { answer: "好", stance: "中性" } }]);
  const next = service.settings({ memory: "我只做主板短线，单笔止损 5%", profileId: "p1" });
  assert.equal(next.memory, "我只做主板短线，单笔止损 5%");
  assert.equal(next.profileId, "p1");
  assert.throws(() => service.settings({ profileId: "missing" }), /不存在/);
  const { runId, conversationId } = service.start({ message: "市场怎么样" });
  await until(() => service.poll(runId).status === "done");
  assert.match(ai.seen[0].system, /单笔止损 5%/);
  assert.equal(store.value.memory, "我只做主板短线，单笔止损 5%");
  assert.equal(service.remove(conversationId).conversations.length, 0);
  assert.equal(service.conversation(conversationId), null);
  assert.throws(() => service.start({ conversationId, message: "还在吗" }), /已被删除/);
  assert.throws(() => service.start({ message: "   " }), /请输入/);
});

test("the agent refuses to start without a model configuration", () => {
  const { service } = serviceWith([], { config: { id: "p1", name: "空", baseUrl: "", model: "", apiKey: "" } });
  assert.equal(service.state().configured, false);
  assert.throws(() => service.start({ message: "茅台" }), /添加模型配置/);
});

test("saved steps keep every prefetched call (seven) so the answer shows all the data it saw", () => {
  const { compactSteps } = require("./stock-agent.cjs");
  const steps = [{ kind: "prefetch", thought: "先读", calls: PREFETCH_TOOLS.map(tool => ({ tool, name: tool, args: "code=600519", status: "ok", summary: "ok" })) }];
  assert.equal(compactSteps(steps)[0].calls.length, PREFETCH_TOOLS.length);
});

test("the saved conversations stay under the size cap by dropping the oldest ones", () => {
  const { MAX_STORE_BYTES } = require("./stock-agent.cjs");
  const big = "长".repeat(4000);
  const conversations = Array.from({ length: 40 }, (_, index) => ({ id: `c${index}`, title: `第${index}段`, focus: null,
    createdAt: `2026-10-${String(index % 28 + 1).padStart(2, "0")}T00:00:00.000Z`, updatedAt: `2026-10-${String(index % 28 + 1).padStart(2, "0")}T00:00:00.000Z`,
    messages: Array.from({ length: 12 }, (_, row) => ({ id: `m${index}-${row}`, role: row % 2 ? "assistant" : "user", content: big, at: "2026-10-01T00:00:00.000Z" })) }));
  const store = { value: { version: 1, memory: "", profileId: "", conversations }, read() { return this.value; }, write(value) { this.value = JSON.parse(JSON.stringify(value)); } };
  const { service } = serviceWith([], { store });
  service.settings({ memory: "短线" });
  assert.ok(Buffer.byteLength(JSON.stringify(store.value)) <= MAX_STORE_BYTES, "the file stays under the cap");
  assert.ok(store.value.conversations.length < 40 && store.value.conversations.length > 0);
  const newest = [...conversations].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0].id;
  assert.ok(store.value.conversations.some(item => item.id === newest), "the most recently used conversation is kept");
});

// —— 分析打法（1.6.54）——
const skillLib = require("./stock-agent-skills.cjs");
const { STOCK_AGENT_TOOLS } = require("./stock-agent-tools.cjs");

test("the built-in analysis skills are complete: real data tools, criteria, focus, five groups", () => {
  const toolIds = new Set(STOCK_AGENT_TOOLS.map(tool => tool.id));
  const skills = skillLib.BUILTIN_SKILLS;
  assert.ok(skills.length >= 18);
  assert.equal(new Set(skills.map(skill => skill.id)).size, skills.length);
  assert.equal(new Set(skills.map(skill => skill.name)).size, skills.length);
  for (const skill of skills) {
    assert.ok(skillLib.SKILL_GROUPS.includes(skill.group), skill.id);
    assert.ok(skill.method.length >= 3 && skill.focus && skill.summary, skill.id);
    for (const spec of skill.tools) assert.ok(toolIds.has(skillLib.parseToolSpec(spec).tool), `${skill.id}: ${spec}`);
  }
  for (const group of skillLib.SKILL_GROUPS) assert.ok(skills.filter(skill => skill.group === group).length >= 2, group);
  const catalog = skillLib.skillCatalog([], id => STOCK_AGENT_TOOLS.find(tool => tool.id === id)?.name || id);
  assert.equal(catalog.maxSelected, 3);
  assert.deepEqual(catalog.skills.find(skill => skill.id === "pullback_low").tools, ["近期K线", "当日分时", "涨停与龙虎榜", "策略信号"]);
});

test("skills resolve to at most three known ones and add their data to the prefetch", () => {
  const custom = [{ id: "sk_mine01", name: "我的低吸", method: "缩量回踩十日线", tools: ["kline"], custom: true }];
  assert.deepEqual(skillLib.resolveSkills(["pullback_low", "nope", "pullback_low", "sk_mine01", "trend_follow", "volume_price"], custom).map(skill => skill.id),
    ["pullback_low", "sk_mine01", "trend_follow"]);
  const focus = { code: "600519", name: "贵州茅台" };
  const calls = skillLib.skillPrefetchCalls(skillLib.resolveSkills(["relay_board", "bottom_reversal"]), focus, ["quote", "profile"]);
  assert.deepEqual(calls.map(call => call.tool), ["quote", "profile", "limit_status", "market", "sector", "intraday", "kline", "strategies", "score"]);
  assert.deepEqual(calls.find(call => call.tool === "kline").args, { code: "600519", days: 40 }, "the longest K-line window wins");
  assert.deepEqual(calls.find(call => call.tool === "market").args, {});
  assert.deepEqual(skillLib.skillPrefetchCalls(skillLib.resolveSkills(["sector_rotation"]), null).map(call => call.tool), ["market", "sector_rank"], "without a stock only market-wide data is prefetched");
});

test("skill verdicts and custom skills are validated", () => {
  const skills = skillLib.resolveSkills(["pullback_low", "trend_follow"]);
  assert.deepEqual(skillLib.normalizeVerdicts([{ skill: "低吸回踩", verdict: "接近", reason: "回调缩量但还没到10日线".repeat(6) }, { skill: "低吸回踩", verdict: "符合" },
    { skill: "趋势跟随", verdict: "大概", reason: "波段看297.43/306.71赔率超3.6倍，但短线前高272.19赔率仅1.3倍" }, { skill: "没选的", verdict: "符合" }], skills).map(item => [item.id, item.verdict, item.reason.slice(-4)]),
    [["pullback_low", "接近", "回调缩…"], ["trend_follow", "不适用", "1.3倍"]], "long reasons end with an ellipsis; a 45-character reason is kept whole");
  const toolIds = new Set(STOCK_AGENT_TOOLS.map(tool => tool.id));
  assert.throws(() => skillLib.normalizeCustomSkill({ name: "", method: "缩量回踩十日线" }, { toolIds }), /名字/);
  assert.throws(() => skillLib.normalizeCustomSkill({ name: "低吸", method: "看看" }, { toolIds }), /判断要点/);
  const skill = skillLib.normalizeCustomSkill({ name: "  尾盘 低吸法 加长加长加长  ", method: "尾盘缩量回踩分时均价线，次日冲高卖", tools: ["intraday", "intraday", "hack", "search_stock", "kline", "quote", "sector", "news", "market", "diagnosis"] }, { toolIds, id: "sk_abc123" });
  assert.equal(skill.name, "尾盘 低吸法 加长加长加");
  assert.deepEqual(skill.tools, ["intraday", "kline", "quote", "sector", "news", "market"], "unknown tools dropped, at most six");
  assert.equal(skill.custom, true);
});

test("an agent turn with skills prefetches their data, puts their method in the prompt and returns verdicts", async () => {
  const { sources } = fakeSources();
  const skills = skillLib.resolveSkills(["pullback_low", "risk_reward"]);
  const ai = scriptedAi([request => {
    assert.match(request.system, /【低吸回踩】：强势股回调到哪里能低吸/);
    assert.match(request.system, /必看数据：近期K线（20根）、当日分时、涨停与龙虎榜、策略信号/);
    assert.match(request.system, /风险收益比 =（目标 − 买点）÷（买点 − 止损）/);
    assert.match(request.system, /"skillVerdicts":\[/);
    const first = JSON.parse(request.messages.at(-1).content);
    assert.ok(["kline", "intraday", "diagnosis"].every(tool => first.initialData.some(item => item.tool === tool)), "skill data is in initialData");
    return { final: { answer: "**结论：接近低吸位**\n\n### 打法：低吸回踩\n- …", stance: "中性", confidence: "中",
      skillVerdicts: [{ skill: "低吸回踩", verdict: "接近", reason: "缩量回调，离10日线还有2%" }, { skill: "风险收益比", verdict: "不符合", reason: "目标空间只有止损的1.3倍" }] } };
  }]);
  const result = await runAgentTurn({ ai, tools: createStockAgentTools(sources), question: "看看", focus: { code: "600519", name: "贵州茅台" }, prefetch: true, skills, clock });
  assert.deepEqual(result.skillVerdicts.map(item => [item.skill, item.verdict]), [["低吸回踩", "接近"], ["风险收益比", "不符合"]]);
  assert.match(result.steps[0].thought, /按「低吸回踩」「风险收益比」/);
  assert.ok(result.steps[0].calls.length > PREFETCH_TOOLS.length);
});

test("the service remembers the chosen skills, tags messages with them and manages custom skills", async () => {
  const { service, ai, store } = serviceWith([
    { final: { answer: "**按打法看：接近**", stance: "中性", skillVerdicts: [{ skill: "低吸回踩", verdict: "接近", reason: "缩量" }] } },
    request => { assert.match(request.system, /【我的尾盘法】（用户自己写的打法）/); assert.match(request.system, /尾盘缩量回踩均价线/); return { final: { answer: "好", stance: "中性", skillVerdicts: [{ skill: "我的尾盘法", verdict: "符合", reason: "尾盘回踩" }] } }; }
  ]);
  const catalog = service.state().skills;
  assert.ok(catalog.skills.length >= 19 && catalog.groups.includes("我的打法"));
  const { runId, conversationId } = service.start({ message: "全面分析", focus: { code: "600519", name: "贵州茅台" }, skillIds: ["pullback_low", "bogus"] });
  await until(() => service.poll(runId).status === "done");
  const messages = service.conversation(conversationId).messages;
  assert.deepEqual(messages[0].skills, [{ id: "pullback_low", name: "低吸回踩" }]);
  assert.deepEqual(messages[1].skillVerdicts.map(item => item.verdict), ["接近"]);
  assert.deepEqual(service.state().skillIds, ["pullback_low"], "the last choice is remembered");
  assert.deepEqual(store.value.skillIds, ["pullback_low"]);

  const saved = service.saveSkill({ name: "我的尾盘法", method: "尾盘缩量回踩均价线，次日冲高卖出", tools: ["intraday", "kline"] });
  const mine = saved.skills.skills.find(skill => skill.custom);
  assert.equal(mine.id, saved.savedSkillId);
  assert.match(mine.id, /^sk_[a-z0-9]{6,32}$/);
  assert.deepEqual(mine.toolIds, ["intraday", "kline"]);
  assert.throws(() => service.saveSkill({ name: "我的尾盘法", method: "另一套要点写在这里", tools: [] }), /已经有叫/);
  assert.throws(() => service.saveSkill({ name: "低吸回踩", method: "和内置重名的打法", tools: [] }), /已经有叫/);
  const edited = service.saveSkill({ id: mine.id, name: "我的尾盘法", method: "尾盘缩量回踩均价线，次日冲高卖出（改）", tools: ["intraday"] });
  assert.equal(edited.skills.skills.filter(skill => skill.custom).length, 1);

  const second = service.start({ conversationId, message: "按我的打法看", skillIds: [mine.id] });
  await until(() => service.poll(second.runId).status === "done");
  assert.equal(ai.seen.length, 2);
  assert.deepEqual(service.state().skillIds, [mine.id]);
  const removed = service.removeSkill(mine.id);
  assert.equal(removed.skills.skills.some(skill => skill.custom), false);
  assert.deepEqual(removed.skillIds, [], "a deleted skill leaves the selection");
  assert.deepEqual(service.settings({ skillIds: ["trend_follow", "volume_price"] }).skillIds, ["trend_follow", "volume_price"]);
});

test("custom skills survive a restart and broken saved skills are dropped", () => {
  const store = memoryStore({ version: 1, memory: "", profileId: "", conversations: [], skillIds: ["sk_keep01", "trend_follow"], skills: [
    { id: "sk_keep01", name: "保留", method: "缩量回踩十日线不破", tools: ["kline", "nope"] }, { id: "bad id", name: "坏的", method: "缩量回踩十日线不破" }, { id: "sk_empty1", name: "", method: "" }] });
  const { service } = serviceWith([], { store });
  const state = service.state();
  assert.deepEqual(state.skills.skills.filter(skill => skill.custom).map(skill => [skill.id, skill.toolIds]), [["sk_keep01", ["kline"]]]);
  assert.deepEqual(state.skillIds, ["sk_keep01", "trend_follow"]);
});

test("审核修复：长数据只压缩数据不截问题；final 可以是字符串；重复调用会被提示", async () => {
  const longQuestion = "请帮我".repeat(200);
  const packed = JSON.parse(fitJson({ question: longQuestion, focus: { code: "600519", name: "贵州茅台" }, initialData: Array.from({ length: 80 }, (_, i) => ({ tool: "x", text: "数据".repeat(200), i })) }, 6000));
  assert.equal(packed.question, longQuestion);
  assert.equal(packed.focus.code, "600519");
  assert.ok(packed.initialData.length < 80);
  assert.equal(validateFinal({ final: "**结论：观望**" }).answer, "**结论：观望**");

  const { sources } = fakeSources();
  const tools = createStockAgentTools(sources);
  const ai = scriptedAi([
    { thought: "看报价", calls: [{ tool: "quote", args: { code: "600519" } }, { tool: "quote", args: { code: "600519" } }] },
    { thought: "再看一次", calls: [{ tool: "quote", args: { code: "600519" } }] },
    { final: { answer: "好" } }
  ]);
  const result = await runAgentTurn({ ai, tools, question: "看看", focus: null, prefetch: false, clock });
  assert.equal(result.steps[0].calls.length, 1, "同一轮里重复的调用只执行一次");
  assert.match(ai.seen[2].messages.at(-1).content, /已经查过/);
  assert.equal(result.answer, "好");
});

test("审核修复：页面传 focus:null 会清除对话的关注股票；选过的配置被删后 profileId 归空", async () => {
  const { service } = serviceWith([{ final: { answer: "一" } }, { final: { answer: "二" } }], { store: memoryStore({ version: 1, memory: "", profileId: "gone", conversations: [] }) });
  assert.equal(service.state().profileId, "");
  const first = service.start({ message: "看看", focus: { code: "600519", name: "贵州茅台" } });
  await until(() => service.poll(first.runId).status === "done");
  const second = service.start({ conversationId: first.conversationId, message: "大盘怎么样", focus: null });
  await until(() => service.poll(second.runId).status === "done");
  const thread = service.conversation(first.conversationId);
  assert.equal(thread.focus, null);
  assert.equal(thread.messages[2].focus, undefined);
});

// Audit regressions: all sources below are local gates, never transport calls.
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function auditService({ chat, clientFor, store = memoryStore(), tools = { catalog: [] } } = {}) {
  let sequence = 0;
  const config = { baseUrl: "https://example.test/v1", model: "synthetic", apiKey: "synthetic" };
  return createStockAgentService({ clientFor: clientFor || (() => ({ chat, model: () => "synthetic" })), resolveProfile: () => config,
    tools, store, clock: () => clock, id: () => `audit${++sequence}`, now: () => Date.UTC(2026, 10, 6) + sequence * 1000 });
}
const auditFinal = answer => ({ final: { answer, stance: "中性", confidence: "中" } });

test("stopped tools signal their source, preserve another subscriber and retain physical drain", async () => {
  const cleanup = deferred();
  let sourceSignal, starts = 0;
  const tools = createStockAgentTools({ timeShare: (_security, options) => { starts++; sourceSignal = options?.signal; return cleanup.promise; } });
  const a = new AbortController(), b = new AbortController();
  const first = tools.runTool("intraday", { code: "600519" }, { signal: a.signal });
  const second = tools.runTool("intraday", { code: "600519" }, { signal: b.signal });
  const firstOutcome = first.catch(error => error);
  const secondOutcome = second.catch(error => error);
  await until(() => starts === 1);
  try {
    assert.ok(sourceSignal instanceof AbortSignal, "the real source receives an owned producer signal");
    a.abort(new Error("first stopped"));
    assert.match((await firstOutcome).message, /first stopped/);
    assert.equal(sourceSignal.aborted, false, "one caller cannot poison a live shared caller");
    b.abort(new Error("second stopped"));
    await secondOutcome;
    assert.equal(sourceSignal.aborted, true);
    let drained = false;
    first.drained.then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false, "logical cancellation does not release real work");
  } finally { a.abort(); b.abort(); cleanup.resolve({ rows: [] }); await Promise.all([firstOutcome, secondOutcome]); }
  await first.drained;
});

test("tool deadlines abort sources and cancelled tools cannot start new source work", async () => {
  let signal;
  const gate = deferred();
  const tools = createStockAgentTools({ timeShare: (_security, options) => { signal = options?.signal; return gate.promise; } }, { toolTimeoutMs: 10 });
  const timed = tools.runTool("intraday", { code: "600519" });
  const keepAlive = setTimeout(() => gate.resolve({ rows: [] }), 2000);
  try {
    const result = await timed;
    assert.equal(result.ok, false);
    assert.equal(signal?.aborted, true, "deadline reaches producer instead of only its race");
    const cancelled = new AbortController(); cancelled.abort(new Error("already stopped"));
    await assert.rejects(tools.runTool("intraday", { code: "600001" }, { signal: cancelled.signal }), /already stopped/);
  } finally { clearTimeout(keepAlive); gate.resolve({ rows: [] }); }
  await timed.drained;
});

test("cancelled turns retain both admission slots until their source work drains", async () => {
  const gates = [], signals = [];
  const tools = createStockAgentTools({ timeShare: (_security, options) => { const gate = deferred(); gates.push(gate); signals.push(options?.signal); return gate.promise; } });
  let number = 0;
  const service = auditService({ tools, chat: async () => ({ calls: [{ tool: "intraday", args: { code: `60000${++number}` } }] }) });
  try {
    for (let index = 0; index < 2; index++) {
      const started = service.start({ message: "lookup" });
      await until(() => gates.length === index + 1);
      service.cancel(started.runId);
      await until(() => service.poll(started.runId).status === "cancelled");
    }
    assert.throws(() => service.start({ message: "third" }), error => error.code === "AGENT_BUSY");
    assert.equal(gates.length, 2);
    assert.ok(signals.every(signal => signal?.aborted));
  } finally { for (const gate of gates) gate.resolve({ rows: [] }); await service.shutdown(); }
});

test("shutdown is idempotent and joins finalization plus original model transport drain", async () => {
  const { createAiClient } = require("./ai-client.cjs");
  const physical = deferred();
  let abortSeen = false, writes = 0;
  const store = memoryStore();
  const originalWrite = store.write;
  store.write = value => { writes++; return originalWrite(value); };
  const service = auditService({ store, clientFor: (config, lifecycle = {}) => createAiClient({ getConfig: () => config, ...lifecycle, fetchImpl: (_url, options) => {
    const logical = new Promise((_resolve, reject) => options.signal.addEventListener("abort", () => { abortSeen = true; reject(options.signal.reason); }, { once: true }));
    Object.defineProperty(logical, "drained", { value: physical.promise });
    return logical;
  } }) });
  const run = service.start({ message: "wait" });
  await new Promise(resolve => setImmediate(resolve));
  const shutdown = service.shutdown();
  let completed = false; shutdown.then(() => { completed = true; });
  try {
    assert.equal(service.shutdown(), shutdown, "all callers join the same shutdown");
    await until(() => abortSeen);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(service.poll(run.runId).status, "cancelled");
  } finally { physical.resolve(); await shutdown; }
  const savedWrites = writes;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(writes, savedWrites, "no transcript writes after shutdown resolves");
});

test("retention pins a running conversation across the count cap and saves its eventual answer", async () => {
  const first = deferred(); let count = 0;
  const store = memoryStore();
  const service = auditService({ store, chat: async () => ++count === 1 ? first.promise : auditFinal("short") });
  const run = service.start({ message: "long question" });
  try {
    await until(() => count === 1);
    for (let index = 0; index < 40; index++) {
      const next = service.start({ message: `new ${index}` });
      await until(() => service.poll(next.runId).status === "done");
    }
    assert.ok(service.conversation(run.conversationId), "running history stays addressable");
    assert.equal(store.value.conversations.length, 40, "inactive threads still obey retention");
  } finally { first.resolve(auditFinal("eventual answer")); await until(() => service.poll(run.runId).status !== "running"); await service.shutdown(); }
  assert.ok(store.value.conversations.find(item => item.id === run.conversationId)?.messages.some(item => item.content === "eventual answer"));
});

test("byte retention evicts inactive history before a pinned conversation", async () => {
  const first = deferred(); let count = 0;
  const store = memoryStore({ version: 1, memory: "", profileId: "", conversations: [
    { id: "long", title: "active", createdAt: "2026-01-01", updatedAt: "2026-01-01", messages: [{ role: "assistant", content: "a".repeat(1_500_000) }] },
    { id: "inactive", title: "inactive", createdAt: "2027-01-01", updatedAt: "2027-01-01", messages: [{ role: "assistant", content: "b".repeat(2_680_000) }] }
  ] });
  const service = auditService({ store, chat: async () => ++count === 1 ? first.promise : auditFinal("x".repeat(12000)) });
  const run = service.start({ conversationId: "long", message: "wait" });
  try {
    await until(() => count === 1);
    for (let index = 0; index < 2; index++) { const next = service.start({ message: `new ${index}` }); await until(() => service.poll(next.runId).status === "done"); }
    assert.ok(service.conversation("long"));
    assert.ok(Buffer.byteLength(JSON.stringify(store.value)) <= require("./stock-agent.cjs").MAX_STORE_BYTES);
  } finally { first.resolve(auditFinal("byte answer")); await until(() => service.poll(run.runId).status !== "running"); await service.shutdown(); }
  assert.ok(store.value.conversations.find(item => item.id === "long")?.messages.some(item => item.content === "byte answer"));
});

test("settings, skill and delete failures reject without changing accepted state", async () => {
  let fail = false;
  const store = memoryStore({ version: 1, memory: "saved old", profileId: "", conversations: [] });
  const write = store.write; store.write = next => { if (fail) throw Object.assign(new Error("no space"), { code: "ENOSPC" }); return write(next); };
  const service = auditService({ store, chat: async () => auditFinal("saved answer") });
  const run = service.start({ message: "hello" });
  await until(() => service.poll(run.runId).status === "done");
  const custom = service.saveSkill({ name: "custom", method: "a complete local synthetic method", tools: [] }).savedSkillId;
  const before = structuredClone(service.state()); const diskBefore = structuredClone(store.value);
  fail = true;
  for (const action of [() => service.settings({ memory: "new", profileId: "new" }), () => service.saveSkill({ id: custom, name: "changed", method: "changed synthetic method", tools: [] }),
    () => service.removeSkill(custom), () => service.remove(run.conversationId)]) {
    assert.throws(action, error => error.code === "AGENT_PERSISTENCE");
    const after = service.state(); delete after.persistenceError;
    assert.deepEqual(after, before);
    assert.deepEqual(store.value, diskBefore);
  }
  fail = false; service.settings({ memory: "retry accepted" });
  assert.equal(service.state().memory, "retry accepted");
  await service.shutdown();
});

test("answer save failure keeps the answer visible and safe retry clears its warning", async () => {
  const response = deferred(); let fail = false;
  const store = memoryStore(); const write = store.write;
  store.write = next => { if (fail) throw Object.assign(new Error("no space"), { code: "ENOSPC" }); return write(next); };
  const service = auditService({ store, chat: () => response.promise });
  const run = service.start({ message: "retain answer" });
  const accepted = structuredClone(store.value); fail = true; response.resolve(auditFinal("valuable answer"));
  await until(() => service.poll(run.runId).status !== "running");
  const done = service.poll(run.runId);
  assert.equal(done.status, "done"); assert.equal(done.message.content, "valuable answer");
  assert.match(done.persistenceError, /保存/); assert.match(done.message.persistenceError, /保存/);
  assert.match(service.conversation(run.conversationId).persistenceError, /保存/);
  assert.equal(service.conversation(run.conversationId).messages.at(-1).content, "valuable answer");
  assert.deepEqual(store.value, accepted, "failed write does not destroy the previous disk state");
  fail = false; const saved = service.settings({});
  assert.equal(saved.persistenceError, undefined); assert.equal(service.poll(run.runId).persistenceError, undefined);
  assert.equal(service.conversation(run.conversationId).messages.at(-1).persistenceError, undefined);
  assert.equal(store.value.conversations[0].messages.at(-1).content, "valuable answer");
  await service.shutdown();
});


test("a pinned thread larger than the store cap rejects admission without deleting prior history", () => {
  let writes = 0;
  const original = { version: 1, memory: "old", profileId: "", conversations: [{ id: "oversize", title: "large", messages: [{ role: "assistant", content: "x".repeat(4 * 1024 * 1024) }] }] };
  const store = { read: () => structuredClone(original), write: () => { writes++; } };
  const service = auditService({ store, chat: async () => auditFinal("never") });
  assert.throws(() => service.start({ conversationId: "oversize", message: "continue" }), error => error.code === "AGENT_PERSISTENCE");
  assert.equal(writes, 0, "oversized pinned state is never silently written or dropped");
  assert.equal(service.conversation("oversize").messages.length, 1);
});

test("settings and custom skill transactions during a turn do not orphan its eventual answer", async () => {
  const response = deferred();
  const store = memoryStore();
  const service = auditService({ store, chat: () => response.promise });
  const run = service.start({ message: "pending" });
  service.settings({ memory: "changed while running" });
  const skill = service.saveSkill({ name: "during", method: "synthetic method while turn runs", tools: [] }).savedSkillId;
  service.removeSkill(skill);
  response.resolve(auditFinal("answer after settings"));
  await until(() => service.poll(run.runId).status === "done");
  assert.equal(store.value.memory, "changed while running");
  assert.equal(store.value.conversations.find(item => item.id === run.conversationId)?.messages.at(-1).content, "answer after settings");
  await service.shutdown();
});

test("read failures reject writes rather than replacing unread prior history with empty state", () => {
  let writes = 0;
  const service = auditService({ store: { read: () => { throw new Error("cannot read existing state"); }, write: () => { writes++; } } });
  assert.throws(() => service.settings({ memory: "new" }), error => error.code === "AGENT_PERSISTENCE");
  assert.equal(writes, 0);
});

test("a failed start saves neither an orphan question nor a model request", () => {
  const store = memoryStore({ version: 1, memory: "saved", profileId: "", conversations: [] });
  store.write = () => { throw new Error("write denied"); };
  let requests = 0;
  const service = auditService({ store, chat: async () => { requests++; return auditFinal("unexpected"); } });
  assert.throws(() => service.start({ message: "not accepted" }), error => error.code === "AGENT_PERSISTENCE");
  assert.equal(requests, 0);
  assert.equal(service.state().conversations.length, 0);
  assert.equal(store.value.conversations.length, 0);
});

test("a failed active delete leaves the turn alive while a successful delete never resurrects it", async () => {
  const response = deferred(); let fail = false, aborted = false;
  const store = memoryStore(); const write = store.write;
  store.write = next => { if (fail) throw new Error("full"); return write(next); };
  const service = auditService({ store, chat: request => new Promise((resolve, reject) => {
    request.signal.addEventListener("abort", () => { aborted = true; reject(request.signal.reason); }, { once: true });
    response.promise.then(resolve, reject);
  }) });
  const run = service.start({ message: "active" });
  fail = true;
  assert.throws(() => service.remove(run.conversationId), error => error.code === "AGENT_PERSISTENCE");
  assert.equal(aborted, false); assert.ok(service.conversation(run.conversationId));
  fail = false; service.remove(run.conversationId);
  await until(() => service.poll(run.runId).status === "cancelled");
  response.resolve(auditFinal("late")); await service.shutdown();
  assert.equal(service.conversation(run.conversationId), null);
  assert.equal(store.value.conversations.length, 0);
});

test("actual main agent adapters forward chart cancellation and preserve its raw drain", async () => {
  const fs = require("node:fs"), path = require("node:path"), vm = require("node:vm");
  const { createAiClient } = require("./ai-client.cjs");
  const source = fs.readFileSync(path.join(__dirname, "main.cjs"), "utf8");
  const loadStart = source.indexOf("async function loadAiStockProfiles("), loadEnd = source.indexOf("\nconst latestDate", loadStart);
  const agentStart = source.indexOf("let stockAgentInstance = null;"), agentEnd = source.indexOf("\nlet thsWebViewManager", agentStart);
  for (const tool of ["intraday", "kline", "profile"]) {
    const cleanup = deferred(); let chartSignal;
    const store = memoryStore();
    const config = { baseUrl: "https://example.test/v1", model: "synthetic", apiKey: "synthetic" };
    const context = {
      createStockAgentTools, createStockAgentService, isAgentStore: require("./stock-agent.cjs").isAgentStore,
      createReviewSkills: () => ({}), createAiClient: options => createAiClient({ ...options, fetchImpl: async () => ({ ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify({ calls: [{ tool, args: { code: "600519" } }] }) } }] }) }) }),
      getChart: (_security, _interval, _options, runtime) => {
        chartSignal = runtime.signal;
        const logical = new Promise((_resolve, reject) => chartSignal.addEventListener("abort", () => reject(chartSignal.reason), { once: true }));
        Object.defineProperty(logical, "drained", { value: cleanup.promise });
        return logical;
      },
      normalizeAiCustomItems: items => items, resolveStockIndustries: async () => new Map(), stockAnnouncements: async () => [],
      situationOf: () => [], readJson: () => store.read(), writeJson: (_name, value) => store.write(value),
      aiProfiles: () => ({ resolve: () => config, list: () => ({ profiles: [], activeId: "" }) }),
      AbortController, AbortSignal, setTimeout, clearTimeout, console
    };
    const service = vm.runInNewContext(`${source.slice(loadStart, loadEnd)}\n${source.slice(agentStart, agentEnd)}\nstockAgent()`, context);
    const run = service.start({ message: "read chart" });
    await until(() => chartSignal);
    service.cancel(run.runId);
    await until(() => service.poll(run.runId).status === "cancelled");
    let shut = false; const shutdown = service.shutdown().then(() => { shut = true; });
    try {
      assert.equal(chartSignal.aborted, true, `${tool} producer signal reaches getChart`);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(shut, false, `${tool} adapter retains the physical chart lifetime`);
    } finally { cleanup.resolve(); await shutdown; }
  }
});

test("unsaved answers remain pinned until a successful full-state save acknowledges them", async () => {
  const response = deferred(); let fail = false;
  const store = memoryStore({ version: 1, memory: "", profileId: "", conversations: Array.from({ length: 40 }, (_, index) => ({
    id: `future${index}`, title: "inactive", createdAt: "2027-01-01", updatedAt: "2027-01-01", messages: []
  })) });
  const write = store.write; store.write = next => { if (fail) throw new Error("full"); return write(next); };
  let count = 0;
  const service = auditService({ store, chat: () => ++count === 1 ? response.promise : Promise.resolve(auditFinal("new answer")) });
  const run = service.start({ message: "valuable" });
  fail = true; response.resolve(auditFinal("unsaved valuable answer"));
  await until(() => service.poll(run.runId).status === "done");
  fail = false;
  const next = service.start({ message: "next" });
  await until(() => service.poll(next.runId).status === "done");
  assert.equal(service.conversation(run.conversationId)?.messages.at(-1).content, "unsaved valuable answer");
  assert.equal(store.value.conversations.find(item => item.id === run.conversationId)?.messages.at(-1).content, "unsaved valuable answer");
  assert.equal(service.poll(run.runId).persistenceError, undefined, "a later full-state save acknowledges the pending answer");
  await service.shutdown();
});

test("sector AI preserves missing counts and reflects confirmed member limit-ups", async () => {
  for (const [members, official, expected] of [
    [[], null, null], [[{ code: "600001", isLimitUp: true, changePct: 10 }], 0, 1],
    [[{ code: "600001", isLimitUp: false, changePct: 1 }], null, null]
  ]) {
    const { sources } = fakeSources({
      industry: async () => "样本行业",
      sectorDetail: async () => ({ name: "样本行业", constituents: members }),
      sectorBoard: async () => ({ industries: [{ name: "样本行业", poolLimitUps: official, memberCount: 4 }] })
    });
    const result = await createStockAgentTools(sources).runTool("sector", { code: "600001" });
    assert.equal(result.data.limitUps, expected);
    if (!members.length) assert.deepEqual([result.data.rising, result.data.falling], [null, null]);
  }
});
