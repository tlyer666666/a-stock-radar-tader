const test = require("node:test");
const assert = require("node:assert/strict");
const { createTrendMarketData } = require("./trend-screener-adapter.cjs");

test("market pages preserve source totals and securities beyond page one", async () => {
  const data = createTrendMarketData({ fetchJson: async (url) => {
    const query = new URL(url).searchParams;
    assert.equal(query.get("pn"), "2");
    assert.equal(query.get("pz"), "100");
    assert.equal(query.get("fs"), "m:0+t:81+s:2048");
    return { data: { total: 251, diff: [{ f12: "920001", f14: "示例", f13: 0, f100: "工业" }] } };
  } });
  const page = await data.fetchUniversePage({ filter: "m:0+t:81+s:2048", page: 2, pageSize: 100 });
  assert.equal(page.total, 251);
  assert.deepEqual(page.rows[0], { code: "920001", name: "示例", secid: "0.920001", industry: "工业", assetType: "stock" });
});

test("daily history keeps raw amount units and optional missing values missing", async () => {
  const requests = [];
  const data = createTrendMarketData({ fetchJson: async (url) => {
    requests.push(new URL(url));
    return { data: { code: "600000", klines: [
      "2026-09-29,10,11,11,9.9,1234,300000000,11,10,1,2.1",
      "2026-09-30,11,11.2,11.4,10.9,2345,2626400,5,1.82,0.2,-"
    ] } };
  } });
  const raw = await data.fetchHistory({ code: "600000", secid: "1.600000" }, "none");
  const adjusted = await data.fetchHistory({ code: "600000", secid: "1.600000" }, "front");
  assert.equal(raw.rows[0].amount, 300000000);
  assert.equal(raw.rows[1].amount, 2626400);
  assert.equal(raw.rows[1].turnover, null);
  assert.equal(raw.rows[0].change, 1);
  assert.equal(raw.adjustment, "none");
  assert.equal(adjusted.adjustment, "front");
  assert.deepEqual(requests.map(url => url.searchParams.get("fqt")), ["0", "1"]);
  assert.equal(raw.rows[0].upperLimit, undefined, "provider response does not supply an official upper limit");
});

test("empty or mismatched source data fails instead of fabricating a complete empty result", async () => {
  const empty = createTrendMarketData({ fetchJson: async () => ({ data: null }) });
  await assert.rejects(empty.fetchUniversePage({ filter: "m:1+t:2", page: 1, pageSize: 100 }));
  await assert.rejects(empty.fetchHistory({ code: "600000", secid: "1.600000" }, "front"));
  const mismatch = createTrendMarketData({ fetchJson: async () => ({ data: { code: "600001", klines: ["2026-09-30,10,10,10,10,1,10000"] } }) });
  await assert.rejects(mismatch.fetchHistory({ code: "600000", secid: "1.600000" }, "none"), /证券/);
});

test("benchmark uses the CSI all share index market identifier", async () => {
  const data = createTrendMarketData({ fetchJson: async (url) => {
    assert.equal(new URL(url).searchParams.get("secid"), "1.000985");
    return { data: { code: "000985", klines: ["2026-09-30,5000,5010,5020,4990,1,10,0.6,0.2,10,0"] } };
  } });
  const rows = await data.fetchBenchmark();
  assert.equal(rows[0].close, 5010);
});

test("transport failure identifies the failed source and preserves network evidence for fail-fast scans", async () => {
  const cause = new TypeError("fetch failed", { cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }) });
  const data = createTrendMarketData({ fetchJson: async () => { throw cause; } });
  await assert.rejects(data.fetchHistory({ code: "600000", secid: "1.600000" }, "front"), error => {
    assert.equal(error.code, "MARKET_DATA_SOURCE_UNAVAILABLE");
    assert.equal(error.source, "eastmoney");
    assert.equal(error.stage, "history");
    assert.equal(error.endpoint, "https://push2his.eastmoney.com/api/qt/stock/kline/get");
    assert.equal(error.cause, cause);
    assert.match(error.message, /前复权/);
    assert.match(error.message, /UND_ERR_SOCKET/);
    assert.match(error.message, /网络|代理/);
    return true;
  });
});

test("source access denial is reported without changing source or inventing an empty market", async () => {
  let calls = 0;
  const data = createTrendMarketData({ fetchJson: async () => {
    calls += 1;
    throw Object.assign(new Error("HTTP 403"), { status: 403 });
  } });
  await assert.rejects(data.fetchUniversePage({ filter: "m:1+t:2", page: 1, pageSize: 100 }), error => {
    assert.equal(error.code, "MARKET_DATA_SOURCE_UNAVAILABLE");
    assert.equal(error.stage, "universe");
    assert.equal(error.status, 403);
    assert.match(error.message, /403/);
    assert.match(error.message, /授权|访问/);
    return true;
  });
  assert.equal(calls, 1);
});

test("provider failure codes take precedence over stale-looking data", async () => {
  const data = createTrendMarketData({ fetchJson: async () => ({
    rc: 100, msg: "service unavailable", data: { total: 0, diff: [] }
  }) });
  await assert.rejects(data.fetchUniversePage({ filter: "m:1+t:2", page: 1, pageSize: 100 }), error => {
    assert.equal(error.code, "MARKET_DATA_SOURCE_UNAVAILABLE");
    assert.match(error.message, /100/);
    return true;
  });
});

test("scan cancellation reaches universe, history and benchmark HTTP requests", async () => {
  const controller = new AbortController();
  const signals = [];
  const data = createTrendMarketData({ fetchJson: async (url, options) => {
    signals.push(options.signal);
    const code = new URL(url).searchParams.get("secid")?.slice(2);
    return code ? { data: { code, klines: ["2026-09-30,10,10,11,9,1,10000"] } }
      : { data: { total: 0, diff: [] } };
  } });
  await data.fetchUniversePage({ filter: "m:1+t:2", page: 1, pageSize: 100, signal: controller.signal });
  await data.fetchHistory({ code: "600000", secid: "1.600000" }, "none", { signal: controller.signal });
  await data.fetchBenchmark({ signal: controller.signal });
  assert.deepEqual(signals, [controller.signal, controller.signal, controller.signal]);
});

test("an aborted request is cancellation rather than a source-wide outage", async () => {
  const controller = new AbortController();
  const reason = new Error("cancel this scan");
  const data = createTrendMarketData({ fetchJson: async () => { controller.abort(reason); throw reason; } });
  await assert.rejects(data.fetchHistory({ code: "600000", secid: "1.600000" }, "none", { signal: controller.signal }), error => error === reason);
});

const networkFailure = () => new TypeError("fetch failed", { cause: Object.assign(new Error("socket closed"), { code: "UND_ERR_SOCKET" }) });
function fallbackPayloads({ mismatch = false, missingAmount = false, missingQfq = false } = {}) {
  return async url => {
    const u = new URL(url);
    if (u.hostname.endsWith("eastmoney.com")) throw networkFailure();
    if (u.hostname === "q.stock.sohu.com") return [{ status: 0, code: "cn_600000", hq: [
      ["2026-09-30", "10", "11", "1", "10%", "9.9", "11", "100", missingAmount ? "-" : "10.5", "1%"],
      ["2026-09-29", "10", "10", "0", "0%", "9.9", "10.1", "100", "10", "1%"]
    ] }];
    const qfq = u.searchParams.get("param")?.endsWith(",qfq");
    return { code: 0, data: { sh600000: qfq && !missingQfq ? { qfqday: [
      ["2026-09-29", "9", "9", "9.09", "8.91", "100"], ["2026-09-30", "9", "9.9", "9.9", "8.91", "100"]
    ] } : { day: [
      ["2026-09-29", "10", "10", "10.1", "9.9", "100"], ["2026-09-30", "10", mismatch ? "10.5" : "11", "11", "9.9", "100"]
    ] } } };
  };
}

test("transport fallback cross-checks raw prices and retains real Sohu amount in yuan", async () => {
  const data = createTrendMarketData({ fetchJson: fallbackPayloads() });
  const controller = new AbortController(), options = { signal: controller.signal };
  const raw = await data.fetchHistory({ code: "600000", secid: "1.600000" }, "none", options);
  assert.equal(raw.rows.at(-1).amount, 105000);
  assert.equal(raw.rows.at(-1).volume, 100);
  assert.equal(raw.provenance.amountUnit, "CNY");
  assert.equal(raw.provenance.crossCheck.matchedRows, 2);
  const front = await data.fetchHistory({ code: "600000", secid: "1.600000" }, "front", options);
  assert.equal(front.rows.at(-1).close, 9.9);
  assert.equal(front.rows.at(-1).amount, 105000);
  assert.equal(front.adjustment, "front");
  const records = data.getDiagnostics(options).sources;
  assert.ok(records.some(row => row.source === "eastmoney" && row.failures > 0));
  assert.ok(records.some(row => row.source === "sohu+tencent-raw" && row.crossCheckedRows === 2));
});

test("cross-source price conflicts, absent amount and absent qfq are unavailable rather than silently repaired", async () => {
  for (const bad of [{ mismatch: true }, { missingAmount: true }, { missingQfq: true }]) {
    const data = createTrendMarketData({ fetchJson: fallbackPayloads(bad) });
    await assert.rejects(data.fetchHistory({ code: "600000", secid: "1.600000" }, bad.missingQfq ? "front" : "none"), error => {
      assert.equal(error.code, "TREND_DATA_UNAVAILABLE");
      assert.match(error.message, /交叉|成交额|前复权/);
      return true;
    });
  }
});

test("CSI benchmark fallback keeps absent turnover null and cannot substitute another index", async () => {
  const data = createTrendMarketData({ fetchJson: async url => {
    const u = new URL(url);
    if (u.hostname.endsWith("eastmoney.com")) throw networkFailure();
    assert.match(u.searchParams.get("param"), /^sh000985,day,/);
    return { code: 0, data: { sh000985: { day: [["2026-09-30", "5600", "5650", "5660", "5590", "123"]] } } };
  } });
  const rows = await data.fetchBenchmark();
  assert.equal(rows[0].close, 5650); assert.equal(rows[0].amount, null);
  assert.equal(data.getDiagnostics().sources.find(row => row.source === "tencent-csi-000985").latestDate, "2026-09-30");
});

test("Sina fallback loads the complete universe once per scan and partitions all five boards", async () => {
  let listCalls = 0, countCalls = 0;
  const rows = [
    { symbol: "sz000001", code: "000001", name: "平安银行" },
    { symbol: "sh600000", code: "600000", name: "浦发银行" },
    { symbol: "sz300001", code: "300001", name: "ST特锐德" },
    { symbol: "sh688001", code: "688001", name: "华兴源创" },
    { symbol: "bj920000", code: "920000", name: "安徽凤凰" }
  ];
  const data = createTrendMarketData({ fetchJson: async url => {
    const u = new URL(url);
    if (u.hostname.endsWith("eastmoney.com")) throw networkFailure();
    if (u.pathname.includes("StockCount")) { countCalls++; return "5"; }
    listCalls++; return rows;
  } });
  const signal = new AbortController().signal;
  for (const [filter, code] of [["m:0+t:6", "000001"], ["m:1+t:2", "600000"], ["m:0+t:80", "300001"], ["m:1+t:23", "688001"], ["m:0+t:81+s:2048", "920000"]]) {
    const page = await data.fetchUniversePage({ filter, page: 1, pageSize: 100, signal });
    assert.equal(page.total, 1); assert.equal(page.rows[0].code, code);
  }
  assert.equal(listCalls, 1); assert.equal(countCalls, 2, "confirm source total after paging");
  await data.fetchUniversePage({ filter: "m:0+t:6", page: 1, pageSize: 100, signal: new AbortController().signal });
  assert.equal(listCalls, 2, "a new scan cannot inherit the previous scan's universe");
});

test("Sina duplicate and truncated pages never establish full-market coverage", async () => {
  for (const duplicate of [false, true]) {
    const data = createTrendMarketData({ fetchJson: async url => {
      const u = new URL(url);
      if (u.hostname.endsWith("eastmoney.com")) throw networkFailure();
      if (u.pathname.includes("StockCount")) return "101";
      return Array.from({ length: duplicate ? 100 : 99 }, (_, i) => ({ code: duplicate ? "600000" : `600${String(i).padStart(3, "0")}`, symbol: `sh600${String(i).padStart(3, "0")}`, name: "证券" }));
    } });
    await assert.rejects(data.fetchUniversePage({ filter: "m:1+t:2", page: 1, pageSize: 100 }), /重复|缺页|完整|不一致/);
  }
});

test("a fallback 503 identifies the individual failed request rather than the dead primary source", async () => {
  let fallbackPolicy;
  const data = createTrendMarketData({ fetchJson: async (url, _options, policy) => {
    if (new URL(url).hostname.endsWith("eastmoney.com")) throw networkFailure();
    fallbackPolicy = policy;
    throw Object.assign(new Error("HTTP 503"), {status: 503});
  } });
  await assert.rejects(data.fetchHistory({code:"600000", secid:"1.600000"}, "none"), error => {
    assert.equal(error.code, "TREND_SOURCE_REQUEST_FAILED");
    assert.match(error.message, /备用源.*503/);
    return true;
  });
  assert.ok(fallbackPolicy.minimumGapMs >= 1000);
  assert.equal(fallbackPolicy.retries, 2);
});

test("raw cross-check compares prices without guessing Tencent volume units across boards", async () => {
  const fixtures = fallbackPayloads();
  const data = createTrendMarketData({ fetchJson: async url => {
    const result = await fixtures(url);
    if (new URL(url).hostname === "web.ifzq.gtimg.cn") result.data.sh600000.day?.forEach(row => {row[5] = "10000";});
    return result;
  } });
  const raw = await data.fetchHistory({code:"600000",secid:"1.600000"}, "none");
  assert.equal(raw.rows[0].volume, 100);
  assert.equal(raw.rows[0].amount, 100000);
  assert.equal(raw.provenance.crossCheck.fields.join(","), "open,high,low,close");
  assert.match(data.getDiagnostics().sources.find(row=>row.source === "sohu+tencent-raw").detail, /量额来自搜狐/);
});

test("a cancelled scan cannot retrieve a previously cached raw response", async () => {
  const data = createTrendMarketData({fetchJson: fallbackPayloads()});
  const controller = new AbortController();
  await data.fetchHistory({code:"600000",secid:"1.600000"},"none",{signal:controller.signal});
  controller.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(data.fetchHistory({code:"600000",secid:"1.600000"},"none",{signal:controller.signal}), {name:"AbortError"});
});

test("Sina all-A recognizes the officially listed 302 ChiNext code", async () => {
  const data=createTrendMarketData({fetchJson:async url=>{
    const u=new URL(url);if(u.hostname.endsWith("eastmoney.com"))throw networkFailure();
    return u.pathname.includes("StockCount")?"1":[{code:"302132",symbol:"sz302132",name:"中航成飞"}];
  }});
  const page=await data.fetchUniversePage({filter:"m:0+t:80",page:1,pageSize:100});
  assert.equal(page.total,1);assert.equal(page.rows[0].code,"302132");
});

test("a failed full Sina universe is not refetched for every board within a scan",async()=>{
  let pages=0;const data=createTrendMarketData({sinaPageRetryDelays:[],fetchJson:async url=>{
    const u=new URL(url);if(u.hostname.endsWith("eastmoney.com"))throw networkFailure();
    if(u.pathname.includes("StockCount"))return "2";pages++;return [];
  }});const signal=new AbortController().signal;
  for(const filter of ["m:0+t:6","m:1+t:2"])await assert.rejects(data.fetchUniversePage({filter,page:1,pageSize:100,signal}));
  assert.equal(pages,1);
  await assert.rejects(data.fetchUniversePage({filter:"m:0+t:6",page:1,pageSize:100,signal:new AbortController().signal}));
  assert.equal(pages,2);
});

test("adapter custom backtest window is explicit while scanner keeps 320 default", async()=>{
  for(const historyBars of [undefined,382,1500]) {
    const calls=[];const payload=fallbackPayloads();
    const data=createTrendMarketData({...(historyBars===undefined?{}:{historyBars}),fetchJson:async url=>{calls.push(new URL(url));return payload(url);}});
    await data.fetchHistory({code:"600000",secid:"1.600000"},"none");
    assert.equal(Number(calls.find(u=>u.hostname.endsWith("eastmoney.com")).searchParams.get("lmt")),historyBars??320);
    assert.equal(Number(calls.find(u=>u.hostname==="web.ifzq.gtimg.cn").searchParams.get("param").split(",")[4]),historyBars??320);
    const sohu=calls.find(u=>u.hostname==="q.stock.sohu.com");
    if(historyBars===1500)assert.ok(Number(sohu.searchParams.get("end").slice(0,4))-Number(sohu.searchParams.get("start").slice(0,4))>=5);
  }
  for(const historyBars of [0,19,1501,300.5,NaN])assert.throws(()=>createTrendMarketData({historyBars}),/historyBars/);
});

for (const code of ['QUEUE_FULL', 'QUEUE_TIMEOUT']) {
  test(`local ${code} never poisons provider health or starts fallback, and recovery retries the primary`, async () => {
    const rejection = Object.assign(new Error('local request capacity'), { code });
    const urls = [];
    const signal = new AbortController().signal;
    const data = createTrendMarketData({ fetchJson: async url => {
      urls.push(new URL(url));
      if (urls.length === 1) throw rejection;
      return { data: { code: '600000', klines: ['2026-09-30,10,11,11,9.9,1234,300000000,11,10,1,2.1'] } };
    } });
    await assert.rejects(data.fetchHistory({ code: '600000', secid: '1.600000' }, 'none', { signal }), error => error === rejection);
    assert.equal(urls.length, 1, 'local capacity rejection cannot produce a fallback request');
    assert.equal(data.getDiagnostics({ signal }).sources.length, 0, 'local rejection is not evidence of provider failure');
    const recovered = await data.fetchHistory({ code: '600000', secid: '1.600000' }, 'none', { signal });
    assert.equal(recovered.rows[0].close, 11);
    assert.deepEqual(urls.map(url => url.hostname), ['push2his.eastmoney.com', 'push2his.eastmoney.com']);
  });
}

test('cancelled trend HTTP work keeps its abort reason and never records a provider failure or fallback', async () => {
  const controller = new AbortController(), reason = new DOMException('cancelled locally', 'AbortError');
  let calls = 0;
  const data = createTrendMarketData({ fetchJson: async () => { calls++; controller.abort(reason); throw reason; } });
  await assert.rejects(data.fetchHistory({ code: '600000', secid: '1.600000' }, 'none', { signal: controller.signal }), error => error === reason);
  assert.equal(calls, 1);
  assert.equal(data.getDiagnostics({ signal: controller.signal }).sources.length, 0);
});

for (const code of ['QUEUE_FULL', 'QUEUE_TIMEOUT']) {
  test(`fallback ${code} preserves local admission error rather than republishing the primary outage`, async () => {
    const rejection = Object.assign(new Error('local fallback capacity'), { code });
    const signal = new AbortController().signal;
    const data = createTrendMarketData({ fetchJson: async url => {
      if (new URL(url).hostname.endsWith('eastmoney.com')) throw new TypeError('network unavailable');
      throw rejection;
    } });
    await assert.rejects(data.fetchHistory({ code: '600000', secid: '1.600000' }, 'none', { signal }), error => error === rejection);
    const sources = data.getDiagnostics({ signal }).sources;
    assert.equal(sources.length, 1);
    assert.equal(sources[0].source, 'eastmoney', 'only the actual primary network failure is provider evidence');
  });
}

const thsRows = (base) => ["2026-10-20", "2026-10-21", "2026-10-22"].map((date, index) => ({ date, open: base + index, high: base + index + 1, low: base + index - 0.5,
  close: base + index + 0.5, volume: 1000 + index, amount: 1e7 + index, turnover: 1.2, changePct: index ? 1 : null, change: index ? 0.1 : null, amplitude: 2 }));

test("THS history retains reference prices and explicit price-basis evidence for the strategy engine", async () => {
  const rows = thsRows(10);
  Object.assign(rows[1], { preClose: 9.5, previousClose: 9.5, upperLimit: 10.45, lowerLimit: 8.55,
    adjustmentFactor: 2, adjFactor: 2, corporateActionUnresolved: true, noPriceLimit: true, isST: false });
  const data = createTrendMarketData({ historyBars: 20, fetchJson: async () => { throw Error("unexpected fallback"); },
    ths: { quote: async () => null, history: async () => rows } });
  const result = await data.fetchHistory({ code: "600000", secid: "1.600000" }, "none");
  assert.equal(result.rows[1].preClose, 9.5);
  assert.equal(result.rows[1].previousClose, 9.5);
  assert.equal(result.rows[1].upperLimit, 10.45);
  assert.equal(result.rows[1].lowerLimit, 8.55);
  assert.equal(result.rows[1].adjustmentFactor, 2);
  assert.equal(result.rows[1].adjFactor, 2);
  assert.equal(result.rows[1].corporateActionUnresolved, true);
  assert.equal(result.rows[1].noPriceLimit, true);
  assert.equal(result.rows[1].isST, false);
});

test("THS free daily history is the primary source; front prices keep raw volume and amount", async () => {
  const eastCalls = [], thsCalls = [];
  const data = createTrendMarketData({ historyBars: 20, fetchJson: async (url) => { eastCalls.push(url); throw new Error("east must not be used"); },
    ths: { quote: async () => ({ latest: 11 }), history: async (security, options) => {
      thsCalls.push(`${security.code}:${options.fqt}`);
      return options.fqt === 1 ? thsRows(5).map((row) => ({ ...row, volume: 1, amount: 1 })) : thsRows(10);
    } } });
  const signal = new AbortController().signal;
  const raw = await data.fetchHistory({ code: "600000", secid: "1.600000" }, "none", { signal });
  const front = await data.fetchHistory({ code: "600000", secid: "1.600000" }, "front", { signal });
  assert.equal(raw.source, "ths-free");
  assert.equal(front.source, "ths-free");
  assert.equal(front.rows[0].close, 5.5, "front prices come from the THS front-adjusted file");
  assert.equal(front.rows[0].amount, 1e7, "volume/amount come from the raw file, never the adjusted one");
  assert.deepEqual(thsCalls, ["600000:0", "600000:1"], "raw history is shared between the raw and front requests");
  assert.equal(eastCalls.length, 0);
  assert.ok(data.getDiagnostics({ signal }).sources.some((item) => item.source === "ths-free" && item.status === "ok"));
});

test("a THS failure falls back to the emergency chain and repeated provider faults pause THS", async () => {
  let thsCalls = 0, now = 1000;
  const data = createTrendMarketData({ historyBars: 20, clock: () => now,
    fetchJson: async (url) => ({ data: { code: new URL(url).searchParams.get("secid").slice(2), klines: ["2026-10-22,10,11,11,9.9,1234,300000000,11,10,1,2.1"] } }),
    ths: { quote: async () => null, history: async () => { thsCalls += 1; throw Object.assign(new Error("HTTP 503"), { status: 503 }); } } });
  const signal = new AbortController().signal;
  for (const code of ["600000", "600001", "600002", "600003"]) {
    const result = await data.fetchHistory({ code, secid: `1.${code}` }, "none", { signal });
    assert.equal(result.source, "eastmoney");
  }
  assert.equal(thsCalls, 3, "after three provider faults THS is paused instead of being hit for every stock");
  now += 61000;
  await data.fetchHistory({ code: "600009", secid: "1.600009" }, "none", { signal });
  assert.equal(thsCalls, 4, "THS is retried once the pause ends");
  const ths = data.getDiagnostics({ signal }).sources.find((item) => item.source === "ths-free");
  assert.match(ths.detail, /已改用应急源/);
});

test("an incomplete THS window for one stock does not pause THS for the others", async () => {
  let thsCalls = 0;
  const data = createTrendMarketData({ historyBars: 20,
    fetchJson: async (url) => ({ data: { code: new URL(url).searchParams.get("secid").slice(2), klines: ["2026-10-22,10,11,11,9.9,1234,300000000,11,10,1,2.1"] } }),
    ths: { quote: async () => null, history: async () => { thsCalls += 1; throw Object.assign(new Error("窗口不足"), { code: "THS_FREE_INCOMPLETE_HISTORY" }); } } });
  const signal = new AbortController().signal;
  for (const code of ["600000", "600001", "600002", "600003", "600004"]) await data.fetchHistory({ code, secid: `1.${code}` }, "none", { signal });
  assert.equal(thsCalls, 5);
});

test("universe rows carry the listed close snapshot for the local daily store, and raw history reads go through the store", async () => {
  const fetchedAt = Date.parse("2026-10-20T15:20:00+08:00");
  const data = createTrendMarketData({ clock: () => fetchedAt, fetchJson: async url => {
    const parsed = new URL(url);
    if (parsed.hostname.startsWith("push2delay")) {
      assert.match(parsed.searchParams.get("fields"), /f2,f5,f6,f8,f15,f16,f17,f18,f124/);
      return { data: { total: 2, diff: [
        { f12: "600001", f14: "样本", f13: 1, f100: "电子", f2: 10.5, f5: 2000, f6: 2100000, f15: 10.6, f16: 10, f17: 10.1, f18: 10, f124: 1792479603 },
        { f12: "600002", f14: "停牌", f13: 1, f100: "电子", f2: "-", f5: "-", f6: "-", f15: "-", f16: "-", f17: "-", f18: 9, f124: 1792393200 }
      ] } };
    }
    throw new Error(`unexpected ${url}`);
  } });
  const page = await data.fetchUniversePage({ filter: "m:1+t:2", page: 1, pageSize: 100 });
  assert.deepEqual(page.rows[0].closeSnapshot, { latest: 10.5, open: 10.1, high: 10.6, low: 10, preClose: 10, volume: 2000, amount: 2100000,
    quoteAt: new Date(1792479603 * 1000).toISOString(), quoteAtIsTradeTime: true, fetchedAt, source: "eastmoney-list" });
  assert.equal(page.rows[1].closeSnapshot, undefined, "suspended rows have no snapshot");

  const calls = [];
  const stored = { rows: [{ date: "2026-10-20", open: 1, high: 1, low: 1, close: 1, volume: 1, amount: 100 }], adjustment: "none", source: "local-store" };
  const withStore = createTrendMarketData({ fetchJson: async () => { throw new Error("network must not be used"); }, ths: null,
    asOf: () => "2026-10-20",
    dailyStore: { history: async (security, asOf, fetchFull, options) => { calls.push([security.code, asOf, typeof fetchFull, options.bars]); return stored; },
      prepareDay: async (securities, asOf) => { calls.push(["prepare", securities.length, asOf]); return { requested: 1, received: 1 }; } } });
  assert.equal(await withStore.fetchHistory({ code: "600001", secid: "1.600001" }, "none"), stored);
  assert.deepEqual(await withStore.prepareHistories([{ code: "600001" }]), { requested: 1, received: 1 });
  assert.deepEqual(calls, [["600001", "2026-10-20", "function", 320], ["prepare", 1, "2026-10-20"]]);
});

test("1.6.47: the universe tries push2 before push2delay, and a throttled Sina page is retried instead of failing the scan", async () => {
  const hosts = [];
  const east = createTrendMarketData({ fetchJson: async url => {
    const u = new URL(url); hosts.push(u.hostname);
    if (u.hostname === "push2.eastmoney.com") return { rc: 0, data: { total: 1, diff: [{ f12: "600000", f14: "浦发银行", f13: 1, f100: "银行" }] } };
    throw networkFailure();
  } });
  const page = await east.fetchUniversePage({ filter: "m:1+t:2", page: 1, pageSize: 100 });
  assert.equal(page.rows[0].code, "600000");
  assert.deepEqual(hosts, ["push2.eastmoney.com"]);

  const tried = [];
  const delayed = createTrendMarketData({ fetchJson: async url => {
    const u = new URL(url); tried.push(u.hostname);
    if (u.hostname === "push2.eastmoney.com") return {};
    if (u.hostname === "push2delay.eastmoney.com") throw networkFailure();
    throw new Error("unexpected");
  } });
  await assert.rejects(delayed.fetchUniversePage({ filter: "m:1+t:2", page: 1, pageSize: 100 }));
  assert.deepEqual(tried.slice(0, 2), ["push2.eastmoney.com", "push2delay.eastmoney.com"], "an empty push2 reply moves on to push2delay");

  let calls = 0;
  const sina = createTrendMarketData({ sinaPageRetryDelays: [0, 0, 0], fetchJson: async url => {
    const u = new URL(url);
    if (u.hostname.endsWith("eastmoney.com")) throw networkFailure();
    if (u.pathname.includes("StockCount")) return "2";
    calls += 1;
    return calls < 3 ? [] : [{ code: "600000", symbol: "sh600000", name: "浦发银行" }, { code: "000001", symbol: "sz000001", name: "平安银行" }];
  } });
  const main = await sina.fetchUniversePage({ filter: "m:1+t:2", page: 1, pageSize: 100 });
  assert.equal(main.source, "sina-all-a");
  assert.deepEqual(main.rows.map(row => row.code), ["600000"]);
  assert.equal(calls, 3, "two throttled replies, then the full page");
});

// A06: reject bad provider evidence before it can become a same-day local hit.
const recoveryDates = require('./trend-trading-calendar.cjs').createTradingCalendar().sessionsThrough('2026-11-05', 120);
const recoverySecurity = { code: '600001', secid: '1.600001', name: '恢复样本' };
const recoveryRows = () => recoveryDates.map(date => ({ date, open: 10, close: 10, high: 10.2, low: 9.8, volume: 100000, amount: 100000000 }));
const eastPayload = rows => ({ rc: 0, data: { code: '600001', klines: rows.map(row => [row.date, row.open, row.close, row.high, row.low, row.volume ?? '-', row.amount ?? '-'].join(',')) } });
for (const [label, corrupt] of [
  ['OHLC conflict', rows => { rows.at(-1).high = 9; }],
  ['duplicate date', rows => { rows.at(-1).date = rows.at(-2).date; }],
  ['missing amount', rows => { rows.at(-1).amount = null; }],
  ['missing volume', rows => { rows.at(-1).volume = null; }],
  ['invalid calendar date', rows => { rows.at(-1).date = '2026-02-30'; }]
]) for (const newTask of [false, true]) test(`A06 ${label} is rejected and corrected same-day history becomes ready (${newTask ? 'new' : 'same'} task)`, async () => {
  const { createDailyBarStore } = require('./daily-bar-store.cjs');
  const store = createDailyBarStore({ previousSession: () => recoveryDates.at(-2) });
  let calls = 0;
  const data = createTrendMarketData({ dailyStore: store, asOf: () => '2026-11-05', ths: null, fetchJson: async () => {
    const rows = recoveryRows(); if (++calls === 1) corrupt(rows); return eastPayload(rows);
  } });
  const signal = new AbortController().signal;
  await assert.rejects(data.fetchHistory(recoverySecurity, 'none', { signal }), { code: 'TREND_DATA_UNAVAILABLE' });
  const repaired = await data.fetchHistory(recoverySecurity, 'none', { signal: newTask ? new AbortController().signal : signal });
  assert.equal(calls, 2, 'the corrected response must actually be downloaded');
  assert.equal(repaired.rows.at(-1).high, 10.2);
  const ready = require('./strategy-signal-engine.cjs').buildStrategySelectionReport([recoverySecurity], { '600001': repaired.rows }, recoveryRows(), {
    selectionOnly: true, minCurrentHistoryBars: 120, asOfDate: '2026-11-05', marketDates: recoveryDates
  });
  assert.equal(ready.dataQuality.processed, 1);
  assert.equal(ready.dataQuality.invalid, 0);
  const local = await data.fetchHistory(recoverySecurity, 'none', { signal: new AbortController().signal });
  assert.equal(local.provenance.cache, 'local');
  assert.equal(calls, 2);
});

test('A06 failed-host evidence expires so a repaired provider is retried in the same task', async () => {
  const { createDailyBarStore } = require('./daily-bar-store.cjs');
  let clock = 1000, calls = 0, recovered = false;
  const store = createDailyBarStore({ previousSession: () => recoveryDates.at(-2), now: () => clock });
  const data = createTrendMarketData({ dailyStore: store, asOf: () => '2026-11-05', clock: () => clock, ths: null, fetchJson: async url => {
    if (new URL(url).hostname.endsWith('eastmoney.com')) {
      calls++; if (!recovered) throw networkFailure(); return eastPayload(recoveryRows());
    }
    throw Object.assign(Error('fallback offline'), { status: 503 });
  } });
  const signal = new AbortController().signal;
  await assert.rejects(data.fetchHistory(recoverySecurity, 'none', { signal }));
  recovered = true; clock += 6 * 60 * 1000;
  const result = await data.fetchHistory(recoverySecurity, 'none', { signal });
  assert.equal(result.rows.at(-1).date, '2026-11-05');
  assert.equal(calls, 2);
});

test('A06 raw task cache expires so the daily store can recover a delayed tail', async () => {
  const { createDailyBarStore } = require('./daily-bar-store.cjs');
  let clock = 1000;
  const store = createDailyBarStore({ previousSession: () => recoveryDates.at(-2), now: () => clock });
  let rawCalls = 0;
  const delayed = createTrendMarketData({ dailyStore: store, asOf: () => '2026-11-06', clock: () => clock, ths: null, fetchJson: async () => {
    rawCalls++; const rows = recoveryRows(); if (rawCalls > 1) rows.push({ ...rows.at(-1), date: '2026-11-06' }); return eastPayload(rows);
  } });
  const first = await delayed.fetchHistory(recoverySecurity, 'none');
  assert.equal(first.rows.at(-1).date, '2026-11-05');
  clock += 4 * 60 * 1000;
  assert.equal((await delayed.fetchHistory(recoverySecurity, 'none')).rows.at(-1).date, '2026-11-05');
  clock += 2 * 60 * 1000;
  assert.equal((await delayed.fetchHistory(recoverySecurity, 'none')).rows.at(-1).date, '2026-11-06');
  assert.equal(rawCalls, 2, 'the adapter cache cannot outlive the store recovery cooldown');
});

test('A06 Eastmoney index history may omit activity but still rejects invalid OHLC', async () => {
  let malformed = false;
  const data = createTrendMarketData({ ths: null, fetchJson: async () => ({ data: { code: '000985', klines: [`2026-11-05,5000,5010,${malformed ? 4990 : 5020},4990,-,-`] } }) });
  const rows = await data.fetchBenchmark();
  assert.equal(rows[0].amount, null);
  assert.equal(rows[0].volume, null);
  malformed = true;
  await assert.rejects(data.fetchBenchmark(), { code: 'TREND_DATA_UNAVAILABLE' });
});
