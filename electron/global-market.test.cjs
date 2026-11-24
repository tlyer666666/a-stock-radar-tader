"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createGlobalMarket, selectGlobalNews, summarizeGlobal, GLOBAL_INSTRUMENTS } = require("./global-market.cjs");

const NOW = Date.parse("2026-11-24T01:30:00.000Z"); // 北京时间 09:30
const iso = beijing => new Date(Date.parse(`${beijing.replace(" ", "T")}+08:00`)).toISOString();

function ulistRows() {
  return [
    { f12: "DJIA", f13: 100, f2: 44210.5, f3: -0.85, f4: -380.2, f17: 44600, f18: 44590.7, f124: 1795467600 },
    { f12: "SPX", f13: 100, f2: 6012.3, f3: -1.12, f4: -68, f17: 6080, f18: 6080.3, f124: 1795467600 },
    { f12: "NDX", f13: 100, f2: 21003.1, f3: -1.6, f4: -341, f17: 21340, f18: 21344.1, f124: 1795467600 },
    { f12: "N225", f13: 100, f2: 38500, f3: 0.4, f4: 150, f17: 38400, f18: 38350, f124: 1795480200 },
    { f12: "KS11", f13: 100, f2: "-", f3: "-", f4: "-", f17: "-", f18: 2500, f124: 0 },
    { f12: "CN00Y", f13: 104, f2: 13500, f3: -0.3, f4: -40, f17: 13540, f18: 13540, f124: 1795480200 },
    { f12: "USDCNH", f13: 133, f2: 7.2512, f3: 0.12, f4: 0.0087, f17: 7.243, f18: 7.2425, f124: 1795480200 }
  ];
}

test("global quotes keep missing numbers as null and summarize US, Asia, A50 and the yuan", async () => {
  const urls = [];
  const market = createGlobalMarket({ now: () => NOW, fetchJson: async url => { urls.push(url); return { data: { diff: ulistRows() } }; } });
  const value = await market.loadMarkets();
  assert.equal(value.quotes.length, GLOBAL_INSTRUMENTS.length);
  assert.match(urls[0], /secids=100\.DJIA,100\.SPX/);
  const kospi = value.quotes.find(item => item.name === "韩国KOSPI");
  assert.equal(kospi.latest, null);
  assert.equal(kospi.changePct, null);
  assert.ok(value.missing.includes("韩国KOSPI"));
  assert.ok(value.missing.includes("恒生指数"), "instruments the API did not return are reported, not zero-filled");
  assert.equal(value.quotes.find(item => item.name === "道琼斯").time, "11-24 05:00");
  assert.match(value.summary, /美股 道琼斯-0\.85%、标普500-1\.12%、纳斯达克-1\.60%/);
  assert.match(value.summary, /亚太 日经225\+0\.40%/);
  assert.doesNotMatch(value.summary, /KOSPI/);
  assert.match(value.summary, /A50期指-0\.30%/);
  assert.match(value.summary, /人民币走弱/);
  // 60 秒内复用缓存
  await market.loadMarkets();
  assert.equal(urls.length, 1);
});

test("summary is empty instead of invented when nothing came back", () => {
  assert.equal(summarizeGlobal([]), "");
});

test("news selection keeps overseas, macro, foreign-media and A-share views inside the window and drops the rest", () => {
  const items = [
    { title: "彭博：高盛上调中国股市评级，看好A股估值修复", summary: "", publishedAt: iso("2026-11-24 08:10"), source: "财联社电报" },
    { title: "美股收盘：三大指数集体收跌，纳指跌1.6%", summary: "", publishedAt: iso("2026-11-24 05:02"), source: "东方财富7×24" },
    { title: "美股收盘：三大指数集体收跌，纳指跌1.6%", summary: "重复", publishedAt: iso("2026-11-24 05:03"), source: "财联社电报" },
    { title: "日经225指数开盘涨0.4%，韩国KOSPI指数开盘跌0.2%", summary: "", publishedAt: iso("2026-11-24 08:01"), source: "东方财富7×24" },
    { title: "美联储理事：年内仍有降息空间", summary: "", publishedAt: iso("2026-11-24 03:30"), source: "财联社电报" },
    { title: "国际油价跌超2%，布伦特原油报70美元", summary: "", publishedAt: iso("2026-11-24 04:40"), source: "财联社电报" },
    { title: "某公司签订重大合同", summary: "公司公告", publishedAt: iso("2026-11-24 08:20"), source: "财联社电报" },
    { title: "路透：欧洲股市收高", summary: "", publishedAt: iso("2026-11-22 20:00"), source: "财联社电报" },
    { title: "坏时间", summary: "美股", publishedAt: "not-a-date", source: "x" }
  ];
  const result = selectGlobalNews(items, { nowMs: NOW, hours: 18, limit: 30 });
  const titles = result.items.map(item => item.title);
  assert.equal(result.items.length, 5);
  assert.ok(!titles.includes("某公司签订重大合同"), "domestic company news is not overseas news");
  assert.ok(!titles.some(title => title.includes("欧洲股市")), "outside the 18h window");
  assert.equal(titles.filter(title => title.startsWith("美股收盘")).length, 1, "same headline from two feeds is kept once");
  assert.equal(result.items[0].category, "aShareView");
  assert.equal(result.items[0].time, "11-24 08:10");
  assert.deepEqual(result.byCategory, { aShareView: 1, overseasMarket: 2, macroPolicy: 1, commodity: 1 });
});

test("news loader merges both feeds, pages the 7x24 list back to overnight and reports a failed source", async () => {
  const urls = [];
  const fetchJson = async url => {
    urls.push(url);
    if (url.includes("cls.cn")) throw new Error("cls down");
    if (url.includes("sortEnd=&")) return { data: { sortEnd: "abc", fastNewsList: [{ code: "1", title: "日经225指数开盘涨0.4%", summary: "", showTime: "2026-11-24 08:01:00" }] } };
    return { data: { sortEnd: "", fastNewsList: [{ code: "2", title: "美股收盘：纳指跌1.6%", summary: "", showTime: "2026-11-24 05:02:00" }] } };
  };
  const market = createGlobalMarket({ now: () => NOW, fetchJson });
  const value = await market.loadNews({ hours: 18 });
  assert.equal(value.items.length, 2);
  assert.ok(urls.some(url => url.includes("sortEnd=abc")));
  assert.deepEqual(value.failedSources, ["财联社电报"]);
  assert.match(value.note, /付费/);
});

test("news loader fails loudly when every source fails", async () => {
  const market = createGlobalMarket({ now: () => NOW, fetchJson: async () => { throw new Error("offline"); } });
  await assert.rejects(market.loadNews(), /均失败/);
});

test("non-positive f2 becomes null, caller abort decouples from pending, and forceRefresh starts a fresh flight", async () => {
  const { normalizeQuote } = require("./global-market.cjs");
  assert.equal(normalizeQuote({ f2: 0, f3: 0, f12: "SPX" }, GLOBAL_INSTRUMENTS[1]).latest, null);

  let release;
  let calls = 0;
  const market = createGlobalMarket({
    now: () => NOW,
    fetchJson: () => {
      calls += 1;
      if (calls === 1) return new Promise(resolve => { release = () => resolve({ data: { diff: ulistRows() } }); });
      return Promise.resolve({ data: { diff: ulistRows() } });
    }
  });
  const firstController = new AbortController();
  const first = market.loadMarkets({ signal: firstController.signal });
  const second = market.loadMarkets();
  firstController.abort(new Error("caller1 aborted"));
  await assert.rejects(first, /caller1 aborted/);
  const forced = market.loadMarkets({ forceRefresh: true });
  assert.equal(calls, 2, "forceRefresh must not join a non-forced pending flight");
  release();
  const [secondVal, forcedVal] = await Promise.all([second, forced]);
  assert.ok(secondVal.quotes.length > 0);
  assert.ok(forcedVal.quotes.length > 0);
});

test("news loader does not swallow AbortError on 2nd page", async () => {
  const market = createGlobalMarket({
    now: () => NOW,
    fetchJson: async url => {
      if (url.includes("cls.cn")) return { data: { roll_data: [] } };
      if (url.includes("sortEnd=&")) return { data: { sortEnd: "p2", fastNewsList: [{ code: "1", title: "日经225涨1%", summary: "", showTime: "2026-11-24 08:01:00" }] } };
      const err = new Error("aborted");
      err.name = "AbortError";
      throw err;
    }
  });
  await assert.rejects(market.loadNews(), { name: "AbortError" });
});

test("news loader merges Eastmoney fast and CLS roll_data and summarizes global snapshot", async () => {
  const { summarizeGlobal } = require("./global-market.cjs");
  const market = createGlobalMarket({
    now: () => NOW,
    fetchJson: async url => {
      if (url.includes("cls.cn")) {
        return {
          data: {
            roll_data: [
              { id: "c1", brief: "【美联储纪要偏鹰】美债收益率上行压制外盘", ctime: Math.floor((NOW - 1800_000) / 1000) }
            ]
          }
        };
      }
      return {
        data: {
          sortEnd: "",
          fastNewsList: [
            { code: "f1", title: "对A股的影响偏中性", summary: "【外盘】隔夜美股分化", showTime: "2026-11-24 08:01:00" }
          ]
        }
      };
    }
  });
  const news = await market.loadNews({ hours: 24 });
  assert.ok(news.items.some(i => i.source === "财联社电报"));
  assert.ok(news.items.some(i => i.source === "东方财富7×24"));
  const summary = summarizeGlobal([{ id: "ixic", name: "纳斯达克", changePct: -1.2, market: "美股" }], news);
  assert.match(summary, /纳斯达克/);
});
