"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFactorScreen, runScreen, percentileScores, weightedScore, barFactors, recentPeriods, sessionFraction, periodScale, FACTOR_STRATEGIES } = require("./factor-screen.cjs");

const NOW = Date.parse("2026-11-27T03:00:00.000Z");
const stock = (code, name, report, quote) => ({ code, name, industry: "测试", report: { period: "2026-09-30", label: "2026年三季报", noticeDate: "2026-10-30", eps: 1, revenueYoyPct: 10, netProfitYoyPct: 10, roePct: 12, grossMarginPct: 30, bps: 8, opCashPerShare: 1.1, ...report },
  quote: { latest: 20, changePct: 1.2, amount: 3e8, floatMarketCap: 2e10, totalMarketCap: 2.5e10, pe: 15, pb: 2, tradeStatus: "trading", ...quote } });
const bars = (count, dailyPct, start = 10) => Array.from({ length: count }, (_, i) => { const close = start * (1 + dailyPct / 100) ** i; return { date: new Date(Date.UTC(2026, 7, 1) + i * 86_400_000).toISOString().slice(0, 10), close, high: close * 1.01 }; });

test("report periods walk back from the latest quarter end", () => {
  assert.deepEqual(recentPeriods(NOW), ["2026-09-30", "2026-06-30", "2026-03-31"]);
  assert.deepEqual(recentPeriods(Date.parse("2027-01-10T00:00:00Z")).slice(0, 2), ["2026-12-31", "2026-09-30"]);
});

test("percentiles reward the right direction, ties share a rank, and missing factors redistribute weight", () => {
  const items = [{ code: "a", factors: { roe: 5, pe: 30 } }, { code: "b", factors: { roe: 20, pe: 10 } }, { code: "c", factors: { roe: 20, pe: null } }];
  const scores = percentileScores(items, ["roe", "pe"]);
  assert.equal(scores.get("a").roe, 0);
  assert.equal(scores.get("b").roe, 75, "two tied at the top share the average rank");
  assert.equal(scores.get("b").pe, 100, "lower PE is better");
  assert.equal(scores.get("c").pe, undefined, "a missing factor gets no score, not zero");
  const full = weightedScore({ roe: 80, pe: 40 }, { roe: 50, pe: 50 });
  assert.equal(full.score, 60);
  const partial = weightedScore({ roe: 80 }, { roe: 60, pe: 40 });
  assert.equal(partial.score, 80);
  assert.equal(partial.coverage, 0.6);
  assert.equal(weightedScore({ roe: 80 }, { roe: 40, pe: 60 }), null, "less than 60% of the weight available → not ranked");
});

test("bar factors need 61 closed bars and measure momentum, volatility and distance from the high", () => {
  assert.equal(barFactors(bars(40, 0.5)), null);
  const up = barFactors(bars(80, 0.5));
  assert.ok(up.momentum60 > 30);
  assert.ok(up.lowVol < 0.01);
  assert.ok(up.oversold > -1.1 && up.oversold < 0);
  const down = barFactors(bars(80, -0.5));
  assert.ok(down.momentum60 < -20);
  assert.ok(down.oversold < -20);
});

test("the screen filters the untradable, ranks by the strategy, and explains each pick with observed facts only", async () => {
  const universe = [
    stock("600001", "优质低估", { roePct: 28, grossMarginPct: 60, opCashPerShare: 1.5 }, { pe: 9, pb: 1.2 }),
    stock("600002", "普通公司", { roePct: 10 }, { pe: 25, pb: 3 }),
    stock("600003", "高估成长", { roePct: 22, revenueYoyPct: 60, netProfitYoyPct: 80 }, { pe: 90, pb: 15 }),
    stock("600004", "*ST 风险", { roePct: 30 }, { pe: 5, pb: 0.5 }),
    stock("600005", "亏损公司", { eps: -0.5, roePct: -8 }, { pe: -20 }),
    stock("600006", "停牌公司", { roePct: 30 }, { tradeStatus: "suspended" }),
    stock("600007", "迷你市值", { roePct: 30 }, { floatMarketCap: 5e8 }),
    stock("600008", "没成交", { roePct: 30 }, { amount: 1e6 }),
    stock("600009", "低ROE", { roePct: 3 }, { pe: 6, pb: 0.6 })
  ];
  const strategy = FACTOR_STRATEGIES.find(item => item.id === "quality_value");
  const result = await runScreen({ universe, strategy, top: 5, loadBars: async item => item.code === "600002" ? null : bars(80, 0.3) });
  assert.deepEqual(result.picks.map(item => item.code), ["600001", "600003", "600002"].filter(code => result.picks.some(pick => pick.code === code)).sort((a, b) => result.picks.find(p => p.code === a).rank - result.picks.find(p => p.code === b).rank));
  assert.equal(result.picks[0].code, "600001");
  assert.ok(!result.picks.some(item => ["600004", "600005", "600006", "600007", "600008", "600009"].includes(item.code)), "ST, loss-making, suspended, tiny, illiquid and low-ROE names are filtered out");
  assert.deepEqual(result.funnel, { universe: 9, amountFilter: "全天 5000 万", tradable: 5, passedFilters: 3, scored: 3, candidates: 3, barsFailed: 1, qualified: 3 });
  const top = result.picks[0];
  assert.equal(top.whySelected.length, 3);
  assert.ok(top.whySelected.every(item => item.quality === "observed"));
  assert.match(top.whySelected.map(item => item.text).join("|"), /ROE 28%，全市场/);
  assert.ok(top.whyNow.some(item => /近 60 个交易日上涨/.test(item.text)));
  assert.ok(top.whyNow.some(item => /2026年三季报披露于 2026-10-30/.test(item.text)));
  assert.equal(top.explanationQuality.whyNow, "ok");
  const noBars = result.picks.find(item => item.code === "600002");
  assert.equal(noBars.whyNow[0].code, "awaiting_evidence");
  assert.equal(noBars.explanationQuality.whyNow, "partial");
  assert.equal(top.factors.pe.value, 9);
  assert.equal(top.factors.roe.weight, 30);
});

test("a momentum strategy re-ranks candidates with bar factors, and candidates without bars lose that weight honestly", async () => {
  const universe = [stock("600001", "强势股", {}, {}), stock("600002", "弱势股", {}, {}), stock("600003", "没日线", {}, {})];
  const strategy = FACTOR_STRATEGIES.find(item => item.id === "momentum_quality");
  const result = await runScreen({ universe, strategy, top: 3, loadBars: async item => item.code === "600001" ? bars(80, 0.6) : item.code === "600002" ? bars(80, -0.4) : null });
  assert.equal(result.picks[0].code, "600001");
  assert.deepEqual(result.picks.map(item => item.code), ["600001"], "falling and bar-less candidates do not qualify as momentum");
  assert.equal(result.funnel.qualified, 1);
  const capped = await runScreen({ universe: [stock("600001", "低基数", { netProfitYoyPct: 24939 }, {})], strategy: FACTOR_STRATEGIES.find(item => item.id === "growth_quality"), top: 3, loadBars: async () => bars(80, 0.2) });
  assert.equal(capped.picks[0].factors.profitGrowth.value, 300, "absurd low-base growth is capped");
  assert.match(JSON.stringify(capped.picks[0].whySelected), /超过 300%（多为上年基数低）|ROE|营收/);
});

test("the service reads the latest complete report period, batches quotes, caches, and fails loudly without data", async () => {
  const urls = [];
  const rows = Array.from({ length: 3200 }, (_, i) => ({ SECURITY_CODE: String(600000 + i), SECURITY_NAME_ABBR: `股票${i}`, DATATYPE: "2026年 三季报", BASIC_EPS: 1, YSTZ: i % 50, SJLTZ: i % 40, WEIGHTAVG_ROE: 5 + (i % 25), XSMLL: 30, BPS: 8, MGJYXJJE: 1, PUBLISHNAME: "测试", NOTICE_DATE: "2026-10-30 00:00:00" }));
  let quoteCalls = 0;
  const service = createFactorScreen({
    now: () => NOW,
    fetchJson: async url => { urls.push(url); const page = Number(url.match(/pageNumber=(\d+)/)[1]); if (!url.includes("2026-09-30")) return { result: { pages: 1, data: [] } }; return { result: { pages: 7, data: rows.slice((page - 1) * 500, page * 500) } }; },
    readQuotes: async securities => { quoteCalls += 1; return { quotes: new Map(securities.map((item, i) => [item.code, { latest: 10 + (i % 30), changePct: 0.5, amount: 2e8, floatMarketCap: 1e10, totalMarketCap: 1.2e10 + i * 1e7, pe: 8 + (i % 40), pb: 1 + (i % 5), tradeStatus: "trading" }])) }; },
    loadBars: async () => bars(80, 0.2)
  });
  const result = await service.screen({ strategyId: "quality_value", top: 10 });
  assert.equal(result.reportPeriod, "2026-09-30");
  assert.equal(urls.length, 7, "one period, seven pages");
  assert.equal(quoteCalls, 4, "3200 codes in batches of 1000");
  assert.equal(result.picks.length, 10);
  assert.equal(result.strategies.length, 6);
  assert.deepEqual(result.warnings, []);
  assert.match(result.note, /没有在本机做过历史回测/);
  await service.screen({ strategyId: "growth_quality" });
  assert.equal(urls.length, 7, "reports cached for 12 hours");
  assert.equal(quoteCalls, 4, "quotes cached for 5 minutes");
  const dead = createFactorScreen({ now: () => NOW, fetchJson: async () => ({ result: { data: [] } }), readQuotes: async () => ({ quotes: new Map() }), loadBars: async () => null });
  await assert.rejects(dead.screen(), /业绩报表没取到/);
});

test("early in the session the turnover filter is scaled or skipped, and ROE thresholds follow the report period", async () => {
  assert.equal(sessionFraction(Date.parse("2026-11-27T01:00:00Z")), 0, "09:00 Beijing");
  assert.equal(sessionFraction(Date.parse("2026-11-27T02:30:00Z")), 0.25, "10:30");
  assert.equal(sessionFraction(Date.parse("2026-11-27T04:00:00Z")), 0.5, "lunch break");
  assert.equal(sessionFraction(Date.parse("2026-11-27T08:00:00Z")), 1, "after the close");
  assert.deepEqual(["2026-03-31", "2026-06-30", "2026-09-30", "2025-12-31"].map(periodScale), [0.25, 0.5, 0.75, 1]);
  const strategy = FACTOR_STRATEGIES.find(item => item.id === "quality_value");
  const thin = [stock("600001", "早盘股", { roePct: 20 }, { amount: 4e6 }), stock("600002", "早盘股二", { roePct: 15 }, { amount: 2e7 })];
  const open = await runScreen({ universe: thin, strategy, top: 5, loadBars: async () => null, nowMs: Date.parse("2026-11-27T01:40:00Z") });
  assert.equal(open.funnel.tradable, 2, "09:40 — turnover is not used yet");
  assert.match(open.funnel.amountFilter, /暂不按成交额筛/);
  const mid = await runScreen({ universe: thin, strategy, top: 5, loadBars: async () => null, nowMs: Date.parse("2026-11-27T02:30:00Z") });
  assert.equal(mid.funnel.tradable, 1, "10:30 — a quarter of the day: threshold 1250 万");
  const q1 = [stock("600003", "一季报公司", { period: "2026-03-31", roePct: 2.5 }, {})];
  assert.equal((await runScreen({ universe: q1, strategy, top: 5, loadBars: async () => null })).funnel.passedFilters, 1, "2.5% in one quarter clears the 8% annual bar scaled to 2%");
  const q3 = [stock("600003", "三季报公司", { period: "2026-09-30", roePct: 2.5 }, {})];
  assert.equal((await runScreen({ universe: q3, strategy, top: 5, loadBars: async () => null })).funnel.passedFilters, 0);
});

test("H3, H4 & M2: top is clamped before bar loads, off-session/weekend/holiday/stale quotes keep full 50M filter, delisted excluded, single-sample score is 50, zero high guarded, dedup & single-flight", async () => {
  const strategy = FACTOR_STRATEGIES.find(item => item.id === "quality_value");
  // H3: top=5000 must clamp to 50 before loading bars
  const many = Array.from({ length: 80 }, (_, i) => stock(String(600000 + i), `股${i}`, { roePct: 15 + (i % 10) }, { pe: 10 + (i % 5) }));
  let barCalls = 0;
  const clamped = await runScreen({ universe: many, strategy, top: 5000, loadBars: async () => { barCalls += 1; return bars(80, 0.2); } });
  assert.equal(barCalls, 50, "top is clamped to 50 before fetching daily bars");
  assert.equal(clamped.picks.length, 50);

  // H4: pre-market (09:00), weekend (Sat 10:30), holiday (isTradingDate=false), and stale quoteDate all use full-day 50M threshold
  const thin = [stock("600001", "冷门股", { roePct: 20 }, { amount: 4e6, quoteDate: "2026-11-26" }), stock("600002", "活跃股", { roePct: 15 }, { amount: 8e7, quoteDate: "2026-11-26" })];
  const preMarket = await runScreen({ universe: thin, strategy, top: 5, loadBars: async () => null, nowMs: Date.parse("2026-11-27T01:00:00Z") });
  assert.equal(preMarket.funnel.tradable, 1, "09:00 pre-market keeps full 50M filter");
  assert.equal(preMarket.funnel.amountFilter, "全天 5000 万");
  const weekend = await runScreen({ universe: [stock("600001", "冷门股", { roePct: 20 }, { amount: 2e7 })], strategy, top: 5, loadBars: async () => null, nowMs: Date.parse("2026-11-28T02:30:00Z") });
  assert.equal(weekend.funnel.tradable, 0, "Saturday 10:30 keeps full 50M filter");
  const holiday = await runScreen({ universe: [stock("600001", "冷门股", { roePct: 20 }, { amount: 2e7 })], strategy, top: 5, loadBars: async () => null, nowMs: Date.parse("2026-11-27T02:30:00Z"), isTradingDate: () => false });
  assert.equal(holiday.funnel.tradable, 0, "holiday weekday keeps full 50M filter");
  const staleQuotes = await runScreen({ universe: thin, strategy, top: 5, loadBars: async () => null, nowMs: Date.parse("2026-11-27T02:30:00Z") });
  assert.equal(staleQuotes.funnel.tradable, 1, "previous-day quoteDate keeps full 50M filter");

  // M2: delisted/unlisted excluded, n===1 uniform score 50, high===0 guarded
  const statusCheck = await runScreen({
    universe: [
      stock("600001", "正常", { roePct: 20 }, { tradeStatus: "trading" }),
      stock("600002", "退市", { roePct: 20 }, { tradeStatus: "delisted" }),
      stock("600003", "未上市", { roePct: 20 }, { tradeStatus: "unlisted" })
    ],
    strategy,
    top: 5,
    loadBars: async () => null
  });
  assert.deepEqual(statusCheck.picks.map(item => item.code), ["600001"]);
  const singleScores = percentileScores([{ code: "a", factors: { roe: 20, pe: 10 } }], ["roe", "pe"]);
  assert.equal(singleScores.get("a").roe, 50);
  assert.equal(singleScores.get("a").pe, 50);
  const zeroHighBars = bars(70, 0.2).map(row => ({ ...row, high: 0 }));
  const bf = barFactors(zeroHighBars);
  assert.ok(Number.isFinite(bf.oversold) && bf.oversold <= 0, "high=0 falls back to close instead of Infinity");

  // M2: deduplicate Eastmoney rows, include BSE codes, decouple reportPending abort, single-flight quotes
  let releaseReports;
  const gate = new Promise(resolve => { releaseReports = resolve; });
  let quoteCalls = 0;
  const dupRows = [
    { SECURITY_CODE: "600001", SECURITY_NAME_ABBR: "重股", DATATYPE: "2026年三季报", BASIC_EPS: 1, YSTZ: 10, SJLTZ: 10, WEIGHTAVG_ROE: 20, XSMLL: 30, BPS: 8, MGJYXJJE: 1, PUBLISHNAME: "测试", NOTICE_DATE: "2026-10-30" },
    { SECURITY_CODE: "600001", SECURITY_NAME_ABBR: "重股", DATATYPE: "2026年三季报", BASIC_EPS: 1, YSTZ: 10, SJLTZ: 10, WEIGHTAVG_ROE: 20, XSMLL: 30, BPS: 8, MGJYXJJE: 1, PUBLISHNAME: "测试", NOTICE_DATE: "2026-10-30" },
    { SECURITY_CODE: "920006", SECURITY_NAME_ABBR: "北交股", DATATYPE: "2026年三季报", BASIC_EPS: 1, YSTZ: 15, SJLTZ: 15, WEIGHTAVG_ROE: 22, XSMLL: 35, BPS: 8, MGJYXJJE: 1, PUBLISHNAME: "测试", NOTICE_DATE: "2026-10-30" }
  ];
  const svc = createFactorScreen({
    now: () => NOW,
    fetchJson: async url => {
      if (url.includes("2026-09-30")) { await gate; return { result: { pages: 1, data: dupRows } }; }
      return { result: { pages: 1, data: [] } };
    },
    readQuotes: async securities => {
      quoteCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return { quotes: new Map(securities.map(s => [s.code, { latest: 20, changePct: 1, amount: 2e8, floatMarketCap: 1e10, totalMarketCap: 1.5e10, pe: 12, pb: 1.5, tradeStatus: "trading" }])) };
    },
    loadBars: async () => bars(70, 0.2)
  });
  const ac = new AbortController();
  const callerA = svc.screen({ strategyId: "quality_value", top: 5, signal: ac.signal });
  const callerB = svc.screen({ strategyId: "quality_value", top: 5 });
  const callerC = svc.screen({ strategyId: "quality_value", top: 5 });
  ac.abort(Object.assign(new Error("cancelled"), { name: "AbortError" }));
  await assert.rejects(callerA, /cancelled/);
  releaseReports();
  const [resB, resC] = await Promise.all([callerB, callerC]);
  assert.equal(resB.funnel.universe, 2, "duplicate 600001 deduped and BSE 920006 included");
  assert.equal(resC.funnel.universe, 2);
  assert.equal(quoteCalls, 1, "concurrent callers share single-flight quotes");
});
