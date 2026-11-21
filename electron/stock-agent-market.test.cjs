"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStockAgentTools, toolCatalogText, securityOf, STOCK_AGENT_TOOLS } = require("./stock-agent-tools.cjs");
const { normalizeFocus, focusPrefetchCalls, systemPrompt } = require("./stock-agent.cjs");
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
  assert.deepEqual(tools({ kind: "market", code: "", name: "大盘" }), ['index_overview:{}', 'market:{}', 'sector_rank:{"kind":"industry","sortBy":"change","top":10}']);
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
  assert.deepEqual(market.map(call => call.tool), ["index_overview", "market", "sector_rank"]);
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
