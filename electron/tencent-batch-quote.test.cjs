"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseTencentBatch, createTencentBatchQuotes, readTencentBatchQuotes } = require("./tencent-batch-quote.cjs");

// 字段文本逐行取自 2026-11-20 qt.gtimg.cn 真实响应。
const LINES = {
  stock: 'v_sh603030="1~全筑股份~603030~2.11~2.34~2.11~1836446~1004041~832405~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~2.11~60468~2.12~3614~2.13~2983~2.14~1569~2.15~1670~~20261120161458~-0.23~-9.83~2.22~2.11~2.11/1836446/391576491~1836446~39158~13.94~-13.03~~2.22~2.11~4.70~27.79~27.79~4.06~2.57~2.11~5.08~-70304~2.13~-159.14~-9.58~~~1.45~39157.6491~21.9651~1041~   A~GP-A~-28.72~18.54~0.00~-31.12~-9.97~3.47~1.65~18.54~12.83~1.93~1316933520~1316933520~-100.00~-25.70~1316933520~~~-39.02~0.00~~CNY~0~___D__F__N~2.20~-4255~";',
  bond: 'v_sh111024="1~澳弘转债~111024~193.810~167.930~160.505~3806300~1896846~1909454~195.000~52~194.990~1~194.968~37~194.948~1003~194.941~36~195.790~4~195.800~20~196.122~6~196.516~5~196.593~1~~20261120161455~25.880~15.41~196.516~158.880~193.810/3806300/6949265600~3806300~694927~656.50~~~196.516~158.880~22.41~~~0.00~201.516~134.344~3.23~1093~182.703~~~~~~694926.5600~0.0000~0~ ~ZQ-KZZ~93.81~-2.61~~~~283.000~130.000~-8.98~-16.13~33.04~~~93.82~8.21~~~~93.81~3.09~~CNY~0~___D__F__Y~194.900~152~";',
  bj: 'v_bj920006="62~晟楠科技~920006~16.27~16.71~16.26~21685~9705~11980~16.27~65~16.26~162~16.25~73~16.24~2~16.23~8~16.47~3~16.49~4~16.50~140~16.52~3~16.55~70~~20261120153341~-0.44~-2.63~17.04~16.03~16.27/21685/35850598~21685~3585.06~4.54~-159.87~~17.04~16.03~6.04~7.78~14.69~4.82~21.72~11.70~0.61~90~16.53~-255.04~184.78~~~~3585.0598~0.0000~0~ ~GP~-39.22~-16.65~0.00~-3.01~-1.70~31.88~13.20~-17.45~-13.46~5.86~47797112~90287200~16.98~-40.25~47797112~~~-43.07~-1.15~~CNY~0~NBFND~0.00~0";',
  etf: 'v_sh510300="1~沪深300ETF华泰柏瑞~510300~4.018~4.060~4.014~45417170~28678272~16738898~4.017~11664~4.016~1655~4.015~6162~4.014~3279~4.013~1861~4.018~14446~4.019~31038~4.020~4236~4.021~113~4.022~144~~20261120161457~-0.042~-1.03~4.035~3.970~4.018/45417170/18175530912~45417170~1817553~8.81~~~4.035~3.970~1.60~2070.91~2070.91~0.00~4.466~3.654~2.38~-25356~4.002~~~~~~1817553.0912~975.0481~24267~   A~ETF~-13.22~-1.59~~~~5.095~3.970~-2.57~-3.83~-13.65~51540787700~51540787700~-33.99~-15.14~51540787700~-0.31~4.0305~-11.75~-0.12~4.0594~CNY~0~___D__F__N~4.010~2619~";',
  suspended: 'v_sh118065="1~艾为转债~118065~133.888~133.888~0.000~0~0~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~~20261120161441~0.000~0.00~0.000~0.000~133.888/0/0~0~0~0.00~~S~0.000~0.000~0.00~~~0.00~160.666~107.110~0.00~0~0.000~~~~~~0.0000~0.0000~0~ ~ZQ-KZZ~33.89~0.00~~~~172.666~121.857~0.06~2.99~-4.92~~~~-14.88~~~~33.89~0.00~~CNY~0~___D__F__Y~0.000~0~";',
  delisted: 'v_sz123001="51~蓝标转债~123001~135.998~135.998~0.000~0~0~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~~20261120090000~0.000~0.00~0.000~0.000~135.998/0/0~0~0~~~D~0.000~0.000~0.00~~~0.00~-1~-1~0.00~0~0.000~~~~~~0.0000~0.0000~0~ ~ZQ-KZZ~0.00~0.00~~~~~~0.00~0.00~0.00~~~~0.00~~~~0.00~0.00~~CNY~0~~0.000~0~";',
  delisted2: 'v_sh110079="1~杭银转债~110079~152.372~152.372~0.000~0~0~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~0.000~0~~20261120090000~0.000~0.00~0.000~0.000~152.372/0/0~0~0~~~D~0.000~0.000~0.00~~~0.00~-1~-1~0.00~0~0.000~~~~~~0.0000~0.0000~0~ ~ZQ-KZZ~0.00~0.00~~~~~~0.00~0.00~0.00~~~~0.00~~~~0.00~0.00~~CNY~0~~0.000~0~";',
  unlisted: 'v_sh600349="1~富通昭和~600349~4.88~4.88~0.00~0~0~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~0.00~0~~20261120090000~0.00~0.00~0.00~0.00~4.88/0/0~0~0~~19.99~U~0.00~0.00~0.00~~5.81~2.89~-1~-1~0.00~0~0.00~23.48~19.99~~~~0.0000~0.0000~0~ ~GP-A~~~0.00~14.44~5.28~~~~~~~118961611~~~~~~~0.00~~CNY~0~~0.00~0~";',
  eastmoney: 'v_sz300059="51~东方财富~300059~18.41~18.37~18.21~2246288~1324584~921704~18.40~947~18.39~348~18.38~1307~18.37~2166~18.36~1832~18.41~3620~18.42~5423~18.43~1012~18.44~3559~18.45~9735~~20261120161400~0.04~0.22~18.49~17.91~18.41/2246288/4102547636~2246288~410255~1.68~19.56~~18.49~17.91~3.16~2465.53~2912.87~2.84~22.04~14.70~1.57~-16749~18.26~18.35~24.10~~~1.33~410254.7636~240.6187~1307~ A A~GP-A-CYB~-20.23~0.66~0.54~14.55~3.15~25.61~17.18~-1.97~-0.75~-2.07~13392365708~15822199875~-55.93~-17.81~13392365708~~~-23.20~-0.11~~CNY~0~~18.50~-12132~";',
  noneMatch: 'v_pv_none_match="1";'
};
const FULL_TEXT = [...Object.values(LINES), "garbage line without match", 'v_xx999999="broken"'].join("\n");

// 生成字段位置正确的测试行（手工数 ~ 数错索引是这个格式最常见的坑）。
const line = (code, prefix = "sh", patch = {}) => {
  const fields = Array(50).fill("0");
  Object.assign(fields, { 0: "1", 1: `名字${code}`, 2: code, 3: "10", 4: "9", 5: "10", 30: "20261120150000",
    31: "1", 32: "1.5", 33: "10", 34: "9", 35: "10/1/100", 36: "1", 37: "0.01", 38: "1",
    40: "", 43: "1", 44: "", 45: "", 47: "11", 48: "9", ...patch });
  return `v_${prefix}${code}="${fields.join("~")}";`;
};

test("parseTencentBatch parses every real response kind and skips junk", () => {
  const map = parseTencentBatch(FULL_TEXT);
  assert.equal(map.size, 9);
  for (const code of ["603030", "111024", "920006", "510300", "118065", "123001", "110079", "600349", "300059"]) {
    assert.ok(map.has(code), code);
  }
  const stock = map.get("603030");
  assert.equal(stock.name, "全筑股份");
  assert.equal(stock.latest, 2.11);
  assert.equal(stock.preClose, 2.34);
  assert.equal(stock.changePct, -9.83);
  assert.equal(stock.tradeStatus, "trading");
  assert.equal(stock.quoteAt, "2026-11-20T08:14:58.000Z");
  assert.equal(stock.quoteDate, "2026-11-20");
  assert.equal(stock.source, "腾讯行情");
  const bond = map.get("111024");
  assert.equal(bond.volumeLots, 3806300);
  assert.equal(bond.amount, 6949265600, "成交额取 [35] 第三段（元）");
  assert.equal(bond.turnover, 656.5);
  assert.equal(bond.amplitude, 22.41);
  assert.equal(bond.limitUp, 201.516);
  assert.equal(bond.limitDown, 134.344);
  const bj = map.get("920006");
  assert.equal(bj.latest, 16.27);
  assert.ok(Math.abs(bj.floatMarketCap - 7.78e8) < 1);
  assert.ok(Math.abs(bj.totalMarketCap - 14.69e8) < 1);
});

test("parseTencentBatch keeps float/total market cap in the right order", () => {
  const quote = parseTencentBatch(FULL_TEXT).get("300059");
  assert.ok(Math.abs(quote.floatMarketCap - 2465.53e8) < 1);
  assert.ok(Math.abs(quote.totalMarketCap - 2912.87e8) < 1);
  assert.ok(quote.totalMarketCap >= quote.floatMarketCap);
});

test("parseTencentBatch maps the [40] trade-status flag and zero-volume amount stays 0", () => {
  const map = parseTencentBatch(FULL_TEXT);
  const suspended = map.get("118065");
  assert.equal(suspended.tradeStatus, "suspended");
  assert.equal(suspended.amount, 0);
  assert.equal(suspended.volumeLots, 0);
  assert.equal(suspended.limitUp, 160.666);
  assert.equal(map.get("123001").tradeStatus, "delisted");
  assert.equal(map.get("123001").limitUp, null, "退市券涨停价为 -1 → null");
  assert.equal(map.get("123001").limitDown, null);
  assert.equal(map.get("600349").tradeStatus, "unlisted");
  assert.equal(map.get("600349").open, null, "0 价字段一律 null");
});

test("parseTencentBatch rejects identity mismatches, bad prices and bad times", () => {
  assert.equal(parseTencentBatch(line("600519", "sh", { 2: "603030" })).size, 0, "字段代码与变量名不符不收");
  assert.equal(parseTencentBatch(line("603030", "sh", { 3: "0" })).size, 0);
  assert.equal(parseTencentBatch(line("603030", "sh", { 3: "" })).size, 0);
  assert.equal(parseTencentBatch(line("603030", "sh", { 30: "" })).size, 0);
  assert.equal(parseTencentBatch("").size, 0);
  assert.equal(parseTencentBatch(null).size, 0);
});

test("parseTencentBatch computes changePct from preClose when [32] is blank", () => {
  const quote = parseTencentBatch(line("603030", "sh", { 3: "11", 4: "10", 32: "" })).get("603030");
  assert.equal(quote.changePct, 10);
});

test("read chunks 450 codes into 3 requests with sh/sz/bj prefixes and headers/policy", async () => {
  const urls = [];
  const optionsSeen = [];
  const { read } = createTencentBatchQuotes({
    fetchBytes: async (url, options, policy) => {
      urls.push(url);
      optionsSeen.push({ options, policy });
      const symbols = new URL(url).pathname.slice(3).split(",");
      return Buffer.from(symbols.map((symbol) => line(symbol.slice(2), symbol.slice(0, 2))).join("\n"), "utf8");
    }
  });
  const securities = [];
  for (let i = 0; i < 150; i++) securities.push({ code: `60${String(i).padStart(4, "0")}` });
  for (let i = 0; i < 150; i++) securities.push({ code: `30${String(i).padStart(4, "0")}` });
  for (let i = 0; i < 150; i++) securities.push({ code: `92${String(i).padStart(4, "0")}` });
  const result = await read(securities);
  assert.equal(urls.length, 3);
  assert.equal(result.chunks, 3);
  assert.equal(result.failedChunks, 0);
  assert.equal(result.quotes.size, 450);
  assert.deepEqual(result.missing, []);
  assert.equal(result.source, "腾讯行情");
  assert.ok(urls[0].includes("sh600000") && urls[0].includes("sz300000"));
  assert.ok(urls[1].includes("sz300050") && urls[1].includes("bj920000"));
  assert.ok(urls[2].includes("bj920100"));
  const { options, policy } = optionsSeen[0];
  assert.equal(options.headers.Referer, "https://gu.qq.com/");
  assert.equal(policy.timeoutMs, 5000);
  assert.equal(policy.retries, 1);
  assert.equal(policy.maxResponseBytes, 1024 * 1024);
});

test("read keeps other chunks when one fails; its codes land in missing", async () => {
  const { read } = createTencentBatchQuotes({
    chunkSize: 2,
    fetchBytes: async (url) => {
      const q = new URL(url).pathname.slice(3);
      if (q.includes("300001")) throw new Error("HTTP 502");
      return Buffer.from(q.split(",").map((symbol) => line(symbol.slice(2), symbol.slice(0, 2))).join("\n"), "utf8");
    }
  });
  const result = await read([{ code: "600000" }, { code: "600001" }, { code: "300001" }, { code: "300002" }]);
  assert.equal(result.chunks, 2);
  assert.equal(result.failedChunks, 1);
  assert.deepEqual([...result.quotes.keys()], ["600000", "600001"]);
  assert.deepEqual(result.missing, ["300001", "300002"]);
});

test("read throws the first error when every chunk failed", async () => {
  const { read } = createTencentBatchQuotes({
    chunkSize: 2,
    fetchBytes: async () => { throw new Error("网络断开"); }
  });
  await assert.rejects(read([{ code: "600000" }, { code: "300001" }]), /网络断开/);
});

test("read rethrows abort and does not swallow it as a chunk failure", async () => {
  const controller = new AbortController();
  const { read } = createTencentBatchQuotes({
    fetchBytes: async (url, options) => new Promise((resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(options.signal.reason));
      setTimeout(() => resolve(Buffer.from("", "utf8")), 50);
    })
  });
  const promise = read([{ code: "600000" }], { signal: controller.signal });
  controller.abort(new Error("用户取消"));
  await assert.rejects(promise, /用户取消/);
});

test("read reports codes above maxCodes in missing and skips invalid input", async () => {
  const requested = [];
  const { read } = createTencentBatchQuotes({
    maxCodes: 3,
    fetchBytes: async (url) => {
      requested.push(...new URL(url).pathname.slice(3).split(",").map((symbol) => symbol.slice(2)));
      return Buffer.from("", "utf8");
    }
  });
  const result = await read([
    { code: "600000" }, { code: "600000" }, { code: "600001" }, { code: "600002" }, { code: "600003" }, { code: "600004" },
    { code: "abc" }, { code: "12345" }, null, "600005"
  ]);
  assert.deepEqual(requested, ["600000", "600001", "600002"]);
  assert.deepEqual(result.missing, ["600000", "600001", "600002", "600003", "600004"], "未取到的与超上限的都报缺");
  assert.equal(result.quotes.size, 0);
});

test("read makes no request for empty input", async () => {
  let calls = 0;
  const { read } = createTencentBatchQuotes({ fetchBytes: async () => { calls += 1; return Buffer.from(""); } });
  const result = await read([]);
  assert.equal(calls, 0);
  assert.equal(result.quotes.size, 0);
  assert.equal(result.chunks, 0);
  assert.deepEqual(result.missing, []);
});

test("shared readTencentBatchQuotes exists for service wiring", () => {
  assert.equal(typeof readTencentBatchQuotes, "function");
});
