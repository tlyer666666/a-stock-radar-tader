"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
function load(name, append = "", requires = {}) {
  const filename = path.join(__dirname, name), module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, "utf8") + "\n" + append, {
    module, exports: module.exports, require: id => requires[id] || createRequire(filename)(id), __dirname, __filename: filename,
    process, console, URL, DOMException, AbortController, AbortSignal, TextDecoder,
    setTimeout, clearTimeout, setImmediate, queueMicrotask, Buffer,
    fetch: async () => { throw Error("Unexpected network"); }
  }, { filename });
  return module.exports;
}
function services(append = "") {
  return load("services.cjs", `module.exports.fixture = { eastQuote, topicPoolForDate, eastmoneyKlineRow, sinaKline, sectorStrength, thsLimitUpConsecutiveBoards, setFetch(fn) { fetchJson = fn; }, setPools(fn) { recentLimitUpPools = fn; }, setSectorLoader(fn) { loadSectorStrength = fn; } }; ${append}`);
}
const security = { code: "600001", secid: "1.600001", thscode: "600001.SH" };
test("P0-01 missing Eastmoney prices are rejected instead of becoming zero, and never create price-break vetoes", async () => {
  const s = services(); s.fixture.setFetch(async () => ({data:{f43:"-",f170:"-",f44:"-",f45:"-",f46:"-",f60:1000}}));
  // 无有效最新价 = 没有报价，不是"0 元行情"：必须抛可分类错误让报价链接力。
  await assert.rejects(() => s.fixture.eastQuote(security), error => error.code === "EAST_NO_PRICE");
  // 原意仍要守住：未知价格不得参与"跌破/低于阈值"的比较而产生风控否决。
  const strategies = s.strategyDefinitionsFor(
    {limitEvent:{low:9},avwap:9,volumeRatio:1.4,relativeTurnover:1,rsSector:0,maxDrawdown:0,closePosition:0.5,preLimitReturn20:0},
    {latest: null, changePct: null, missingFields: ["latest"]}
  );
  assert.doesNotMatch(strategies.find(item => item.id === "riskVeto").detail, /跌破/);
});
test("P0-01 market breadth excludes unknown changes from its denominator", async () => {
  const s = services(); s.fixture.setFetch(async url => String(url).includes('/clist/')
    ? {data:{total:5,diff:[{f3:1},{f3:0},{f3:-1},{f3:"-"},{f3:null}]}}
    : {data:{f43:1000,f170:100}});
  const result = await s.wholeMarketSnapshot();
  assert.equal(result.stockCount,3); assert.equal(result.downCount,1); assert.equal(result.flatCount,1); assert.equal(result.upCount,1);
});
test("A2-03 the whole-market snapshot keeps an unavailable index return null instead of 0", async () => {
  // 全市场涨跌家数正常、但中证全指的行情取不到（E-01 之后的 eastQuote 会抛 EAST_NO_PRICE）。
  const s = services();
  s.fixture.setFetch(async (url) => {
    const target = String(url);
    if (target.includes("/clist/")) return { data: { total: 5, diff: [{ f3: 1 }, { f3: 0 }, { f3: -1 }, { f3: "-" }, { f3: null }] } };
    throw Object.assign(new Error("东方财富无有效最新价"), { code: "EAST_NO_PRICE" });
  });
  const snapshot = await s.wholeMarketSnapshot();
  assert.equal(snapshot.available, true);
  assert.equal(typeof snapshot.breadth, "number", "breadth 仍按家数计算");
  assert.equal(snapshot.averageReturn, null, "指数取不到时平均收益是未知，不是平盘 0%");
  assert.equal(snapshot.indexReturn, null);

  // 指数可用时仍返回真实数值。
  s.fixture.setFetch(async (url) => String(url).includes("/clist/")
    ? { data: { total: 5, diff: [{ f3: 1 }, { f3: 0 }, { f3: -1 }, { f3: "-" }, { f3: null }] } }
    : { data: { f43: 1000, f170: -75 } });
  const measured = await s.wholeMarketSnapshot({ forceRefresh: true });
  assert.equal(measured.averageReturn, -0.75);
  assert.equal(measured.indexReturn, -0.75);
});

test("P0-03 identifiers include 920 and reject B shares and delisted transfer codes", () => {
  const s = services(); assert.equal(s.toSecurity("920001").thscode,"920001.BJ");
  for (const code of ["900901","400001"]) assert.throws(() => s.toSecurity(code));
  const n = require("./news-service.cjs").normalizeClsTelegraph({id:1,title:"样本",stock_list:[{stock_code:"920001"}]});
  assert.equal(n.relatedStocks[0].secid,"0.920001");
});
test("P0-04 rc0 null pool is unknown until a source date independently confirms an empty day", async () => {
  const s = services(); s.fixture.setFetch(async () => ({rc:0,data:null}));
  const pool = await s.fixture.topicPoolForDate("2026-10-19","failed");
  assert.equal(pool.pool.length,0); assert.equal(pool.serverTradingDate,""); assert.equal(pool.dateConfirmed,false);
  s.fixture.setFetch(async () => ({rc:2,data:null}));
  await assert.rejects(s.fixture.topicPoolForDate("2026-10-16","failed"),/异常/);
});
test("P1-06 a single ladder date never invents a prior-day population", async () => {
  const s = services(); s.fixture.setPools(async () => [{date:"2026-10-19",pool:[{code:"600001"}]}]);
  s.fixture.setFetch(async () => ({data:{qdate:20261019,pool:[]}}));
  const result = await s.currentLadderPools(); assert.equal(result.previousDate,""); assert.equal(result.previousPool.length,0);
});
test("P1-08 parses true consecutive boards and preserves non-consecutive windows as unknown", () => {
  const s = services(); assert.equal(s.fixture.thsLimitUpConsecutiveBoards({high_days:"3连板",is_again_limit:1}),3);
  assert.equal(s.fixture.thsLimitUpConsecutiveBoards({high_days:"5天4板",is_again_limit:1}),null);
});
test("P1-12 Sina market caps convert ten-thousand-yuan fields and preserve already-yuan fields", () => {
  const s = services(); const row = s.normalizeSinaSectorMembers([{code:"600001",mktcap:100,nmc:50}])[0];
  assert.equal(row.totalMarketCap,1e6); assert.equal(row.floatMarketCap,5e5);
  assert.equal(s.normalizeSinaSectorMembers([{code:"600001",totalMarketCap:1e6}])[0].totalMarketCap,1e6);
});
test("P1-13 sector cache separates credentials and full analysis context", async () => {
  const s = services(); let calls=0; s.fixture.setSectorLoader(async (_sector, context) => ({tag:++calls,breadth:context.marketBreadth}));
  const a=await s.fixture.sectorStrength("机器人",{options:{refreshToken:"one"}});
  const b=await s.fixture.sectorStrength("机器人",{options:{refreshToken:"two"}});
  const c=await s.fixture.sectorStrength("机器人",{options:{refreshToken:"two"},marketBreadth:0.7,ladderPools:{currentDate:"2026-10-19",currentPool:[]}});
  assert.notEqual(a.tag,b.tag); assert.notEqual(b.tag,c.tag);
});
test("P0-07 provider-normalized daily volume has one explicit lot unit", () => {
  const s = services(); const east=s.fixture.eastmoneyKlineRow("2026-10-19,10,10,10,10,100,100000,0,0,0,0");
  const ths=s.normalizeThsHistoryTable({time:["2026-10-19"],open:[10],close:[10],high:[10],low:[10],volume:[10000],amount:[100000]});
  assert.equal(east.volumeUnit,"lots"); assert.equal(ths[0].volumeUnit,"lots"); assert.equal(east.volume,ths[0].volume);
});
test("P1-11 news dedupe leaves cached source objects and order untouched", () => {
  const {dedupeItems}=require("./news-service.cjs");
  const rows=[{id:"a",title:"同一公告",publishedAt:"2026-10-19T02:00:00Z",source:"B源",sourceLevel:"B"},{id:"b",title:"同一公告",publishedAt:"2026-10-19T01:00:00Z",source:"A源",sourceLevel:"A"}];
  const before=JSON.stringify(rows); dedupeItems(rows); assert.equal(JSON.stringify(rows),before);
});
test("P0-07 AVWAP is identical across lots/shares and missing turnover stays unknown", () => {
  const { anchoredVwap } = require("./market-history-rules.cjs");
  assert.equal(anchoredVwap([{volume:100,volumeUnit:"lots",amount:100000}]),10);
  assert.equal(anchoredVwap([{volume:10000,volumeUnit:"shares",amount:100000}]),10);
  assert.equal(anchoredVwap([{volume:100,volumeUnit:"lots",amount:null}]),null);
});
test("P1-09 missing failed pool and previous date remain unknown without optimistic scoring", () => {
  const r=load("review-service.cjs","module.exports.fixture={buildLimitEcology,indexReview};");
  const result=r.fixture.buildLimitEcology({limitUpCount:100}, {currentPool:[{code:"600001",consecutiveBoards:null}],previousPool:[],failedPool:null,failedPoolAvailable:false});
  assert.equal(result.failedBoards,null); assert.equal(result.failedRate,null); assert.equal(result.promotionRate,null);
  assert.equal(result.firstBoards,0); assert.equal(result.maxHeight,null); assert.equal(result.score,50);
});
test("P1-09 ecology uses one non-ST stock universe", () => {
  const r=load("review-service.cjs","module.exports.fixture={buildLimitEcology,indexReview};");
  const result=r.fixture.buildLimitEcology({limitUpCount:99,limitDownCount:1}, {currentPool:[{code:"600001",name:"甲",consecutiveBoards:1},{code:"600002",name:"ST乙",consecutiveBoards:2}],previousPool:[{code:"600001"}],failedPool:[{code:"600003",name:"ST丙"}],failedPoolAvailable:true});
  assert.equal(result.limitUpCount,1); assert.equal(result.failedBoards,0); assert.equal(result.maxHeight,1);
});
test("P1-10 reports use Shanghai dates around midnight", () => {
  const {shanghaiDateTime}=require("./market-time-rules.cjs");
  assert.equal(shanghaiDateTime("2026-10-18T17:00:00Z"),"2026-10-19 01:00:00");
});
test("P2 sessions recognize weekends and official 2026 exchange closures", () => {
  const {marketSession}=require("./review-service.cjs");
  assert.equal(marketSession("2026-10-18T02:00:00Z"),"休市");
  assert.equal(marketSession("2026-10-01T02:00:00Z"),"休市");
});
test("P2 unfinished daily amount is not compared with five full trading days", () => {
  const r=load("review-service.cjs","module.exports.fixture={indexReview};");
  const rows=Array.from({length:20},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,"0")}`,open:10,high:11,low:9,close:10,amount:100}));
  rows[19].date="2026-10-19"; rows[19].amount=20;
  const result=r.fixture.indexReview({code:"000985"},{rows},"2026-10-19T02:00:00Z");
  assert.equal(result.volumeRatio,null); assert.equal(result.volumeRatioBasis,"awaiting-close");
});
test("P1-14 raw limit events map to adjusted chart levels without adjusted-rounding guesses", () => {
  const s=services();
  const raw=Array.from({length:25},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,"0")}`,open:10,high:10,low:10,close:10,volume:100,amount:100000}));
  raw[20]={...raw[20],open:10,close:11,high:11,low:10};
  for(let i=21;i<25;i++) raw[i]={...raw[i],open:11,close:11,high:11.1,low:10.9};
  const adjusted=raw.map(row=>({...row,open:row.open*0.471,high:row.high*0.471,low:row.low*0.471,close:row.close*0.471}));
  const a=s.analyzeHistory(security,{name:"样本",latest:adjusted.at(-1).close},adjusted,null,null,[],raw);
  assert.equal(a.limitEvent?.date,"2026-09-21"); assert.equal(a.limitEvent?.low,4.71); assert.equal(a.limitEvent?.rawClose,11);
  assert.equal(s.analyzeHistory(security,{name:"样本",latest:5},adjusted,null,null,[],[]).limitEvent,null);
});
test("P1-14 AVWAP uses the adjusted price basis when raw cash and shares are unchanged", () => {
  const s=services(); const raw=Array.from({length:25},(_,i)=>({date:`2026-09-${String(i+1).padStart(2,"0")}`,open:10,high:10,low:10,close:10,volume:100,amount:100000}));
  const adjusted=raw.map(row=>({...row,open:5,high:5,low:5,close:5}));
  assert.equal(s.analyzeHistory(security,{name:"样本",latest:5},adjusted,null,null,[],raw).avwap,5);
});
test("P1-10 THS report request sends Shanghai wall-clock timestamps", async () => {
  const n=load("news-service.cjs","module.exports.fixture = { fetchThsReports, setFetch(fn) { fetchJson=fn; } };",{"./ths-token-manager.cjs":{withThsAccessToken:async(_token,_fetch,request)=>request("offline")}});
  let body; n.fixture.setFetch(async(_url,options)=>{body=JSON.parse(options.body);return {errorcode:0,tables:[]};});
  await n.fixture.fetchThsReports({provider:"ths",refreshToken:"offline"});
  assert.ok(Math.abs(Date.parse(body.endcTime.replace(" ","T")+"+08:00")-Date.now())<2000);
});
test("P1-07 and P1-08 unknown height is never decorated or counted as a first board", () => {
  const {decorateLimitPoolItem,buildSectorLadder}=require("./strategy-intelligence.cjs");
  const row=decorateLimitPoolItem({c:"600001",n:"样本"}); assert.equal(row.consecutiveBoards,null);
  const ladder=buildSectorLadder({currentPool:[row],previousPool:[],failedPool:[]});
  assert.equal(ladder.firstBoards,0); assert.equal(ladder.maxHeight,null); assert.equal(ladder.promotionRate,null); assert.equal(ladder.score,null);
});
test("E-04 a malformed news payload is a source failure, never a cached 0-item success", async () => {
  const n = load("news-service.cjs", "module.exports.fixture = { fetchPublicFeed, setFetch(fn) { fetchJson = fn; } };", {});
  const fastItem = { code: "202610190001", title: "样本快讯", summary: "样本摘要", showTime: "2026-10-19T02:00:00Z" };
  const clsItem = { id: 9001, title: "样本电报", content: "样本内容", ctime: 1790000000 };
  let fastPayload = { data: null }; // 反爬/错误页：HTTP 200 + 空壳 JSON
  n.fixture.setFetch(async (url) => {
    const target = String(url);
    if (target.includes("getFastNewsList")) return fastPayload;
    if (target.includes("api/cache")) return { data: { roll_data: [clsItem] } };
    return { data: { list: [] } };
  });
  const broken = await n.fixture.fetchPublicFeed({});
  const brokenStatus = broken.status.find((entry) => entry.id === "fast");
  assert.equal(brokenStatus.ok, false, "结构不符必须标记该源失败");
  assert.match(brokenStatus.message, /结构异常/);
  assert.equal(broken.items.length, 1, "只有真正成功的源贡献条目");
  // 坏响应不得进缓存：恢复后立刻拿到真实条目，而不是复用「0 条 · 使用缓存」。
  fastPayload = { data: { fastNewsList: [fastItem] } };
  const healthy = await n.fixture.fetchPublicFeed({});
  assert.equal(healthy.items.length, 2);
  const healthyStatus = healthy.status.find((entry) => entry.id === "fast");
  assert.equal(healthyStatus.ok, true);
  assert.equal(healthyStatus.message, "1条");
});
test("legacy historical intelligence rejects opening limit-up entries even after intraday reopening", () => {
  const {buildHistoricalStrategyStats}=require("./strategy-intelligence.cjs");
  const rows=Array.from({length:80},(_,i)=>({date:new Date(Date.UTC(2026,0,i+1)).toISOString().slice(0,10),open:10,high:10.1,low:9.9,close:10,volume:100,amount:100000}));
  rows[35]={...rows[35],close:11,high:11};
  for(let i=36;i<80;i++) rows[i]={...rows[i],open:11,close:11,high:11.1,low:10.9,amount:110000};
  rows[39]={...rows[39],open:12.1,high:12.1,low:10.9};
  const result=buildHistoricalStrategyStats(rows,"600001","样本",["support"]);
  assert.equal(result.untradeableCount,1);
});
