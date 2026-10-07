const test = require("node:test");
const assert = require("node:assert/strict");
const services = require("./services.cjs");
const {
  buildProfessionalReviewSnapshot,
  getProfessionalReview,
  marketSession,
  resetProfessionalReviewCache
} = require("./review-service.cjs");

function chart(lastClose, changes = [0.2, 0.4, 0.6, 0.8, 1]) {
  let close = lastClose - 4;
  return {
    rows: Array.from({ length: 30 }, (_, index) => {
      close += index >= 25 ? changes[index - 25] || 0.2 : 0.08;
      return {
        date: `2026-07-${String(index + 1).padStart(2, "0")}`,
        open: close - 0.2,
        close,
        high: close + 0.4,
        low: close - 0.4,
        amount: 1_000_000_000 + index * 10_000_000
      };
    })
  };
}

test("market session always uses China Standard Time", () => {
  assert.equal(marketSession("2026-07-30T01:14:00Z"), "盘前");
  assert.equal(marketSession("2026-07-30T01:15:00Z"), "上午盘中");
  assert.equal(marketSession("2026-07-30T03:30:00Z"), "午间");
  assert.equal(marketSession("2026-07-30T05:00:00Z"), "下午盘中");
  assert.equal(marketSession("2026-07-30T07:00:00Z"), "收盘复盘");
  assert.equal(marketSession("2026-07-30T15:10:00+08:00"), "收盘复盘");
});

test("professional review derives regime, ecology and conditional playbook from facts", () => {
  const currentPool = [
    { code: "000001", name: "甲公司", consecutiveBoards: 3, industry: "机器人", openBoardCount: 0, firstSealRaw: 93000 },
    { code: "000002", name: "乙公司", consecutiveBoards: 2, industry: "机器人", openBoardCount: 1, firstSealRaw: 94500 },
    { code: "000003", name: "丙公司", consecutiveBoards: 1, industry: "算力", openBoardCount: 0, firstSealRaw: 95500 }
  ];
  const previousPool = [
    { code: "000001" },
    { code: "000002" },
    { code: "000009" }
  ];
  const review = buildProfessionalReviewSnapshot({
    generatedAt: "2026-07-30T15:10:00+08:00",
    emotion: {
      date: "2026-07-30",
      limitUpCount: 96,
      limitDownCount: 5,
      previousLimitUpCount: 72,
      score: 80
    },
    market: {
      stockCount: 5300,
      upCount: 3600,
      downCount: 1500,
      flatCount: 200,
      breadth: 3600 / 5300,
      averageReturn: 1.1
    },
    ladderPools: {
      currentPool,
      previousPool,
      failedPool: [{ code: "000010" }]
    },
    sectors: [
      { name: "机器人", score: 83, relativeReturn: 2.1, poolShare: 0.22 },
      { name: "算力", score: 76, relativeReturn: 1.3, poolShare: 0.18 },
      { name: "CPO", score: 69, relativeReturn: 0.8, poolShare: 0.1 }
    ],
    indices: [
      ["中证全指", "000985"],
      ["上证指数", "000001"],
      ["深证成指", "399001"],
      ["创业板指", "399006"],
      ["沪深300", "000300"]
    ].map(([name, code], index) => ({
      definition: { name, code, secid: `${index ? 0 : 1}.${code}` },
      chart: chart(100 + index)
    }))
  });

  assert.equal(review.date, "2026-07-30");
  assert.equal(review.session, "收盘复盘");
  assert.ok(review.score >= 60);
  assert.ok(["趋势进攻", "修复轮动"].includes(review.regime.name));
  assert.equal(review.ecology.promoted, 2);
  assert.equal(review.ecology.maxHeight, 3);
  assert.equal(review.focusSectors[0].name, "机器人");
  assert.equal(review.leaders[0].name, "甲公司");
  assert.equal(review.scenarios.length, 3);
  assert.ok(review.scenarios.every((item) => item.conditions.length >= 3));
  assert.ok(review.nextPlan.avoid.length >= 3);
  assert.equal(review.indices.length, 5);
});

test("professional review enters defense when breadth and limit ecology deteriorate", () => {
  const review = buildProfessionalReviewSnapshot({
    generatedAt: "2026-07-30T14:10:00+08:00",
    emotion: {
      date: "2026-07-30",
      limitUpCount: 18,
      limitDownCount: 42,
      previousLimitUpCount: 60,
      score: 25
    },
    market: {
      stockCount: 5300,
      upCount: 900,
      downCount: 4100,
      flatCount: 300,
      breadth: 900 / 5300,
      averageReturn: -2.2
    },
    ladderPools: {
      currentPool: [{ code: "000001", name: "甲公司", consecutiveBoards: 1 }],
      previousPool: Array.from({ length: 8 }, (_, index) => ({ code: `00000${index + 1}` })),
      failedPool: Array.from({ length: 9 }, (_, index) => ({ code: `30000${index + 1}` }))
    },
    sectors: [{ name: "防御", score: 42, relativeReturn: -1.2, poolShare: 0.1 }],
    indices: Array.from({ length: 5 }, (_, index) => ({
      name: `指数${index + 1}`,
      close: 90,
      ma5: 95,
      ma20: 100,
      score: 20,
      returns: { r1: -2, r3: -4, r5: -6 }
    }))
  });

  assert.equal(review.regime.name, "退潮防守");
  assert.equal(review.exposure.max, null, "legacy scores must not recommend account exposure");
  assert.ok(review.riskSignals.some((item) => item.includes("上涨广度")));
  assert.ok(review.riskSignals.some((item) => item.includes("跌停/涨停比")));
});

test("missing market inputs remain unknown and cannot generate a score-based position plan", () => {
  const review = buildProfessionalReviewSnapshot({ generatedAt: "2026-09-30T08:00:00Z" });
  assert.equal(review.decision.status, "insufficient");
  assert.equal(review.decision.marketGate, "unknown");
  assert.equal(review.decision.canPlan, false);
  assert.equal(review.exposure.max, null);
  assert.ok(review.decision.steps[0].facts.some(text => /缺|不足|不可用/.test(text)));
  assert.ok(review.decision.steps[3].facts.some(text => /炸板.*不可用|不可用.*炸板/.test(text)));
});

test("market MA60 needs sixty actual observations; high legacy scores cannot overturn the gate", () => {
  const input = { generatedAt: "2026-09-30T08:00:00Z", emotion: { date: "2026-09-30", score: 99 }, market: { stockCount: 100, upCount: 80, downCount: 20, flatCount: 0 }, sectors: [{ name: "合成板块", relativeReturn: 1 }], ladderPools: { currentPool: [], previousPool: [], failedPool: [], failedPoolAvailable: true }, indices: [{ definition: { code: "000985", name: "中证全指" }, chart: chart(100) }] };
  assert.equal(buildProfessionalReviewSnapshot(input).decision.marketGate, "unknown");
  input.indices = [{ code: "000985", name: "中证全指", date: "2026-09-30", historyBars: 65, ma60: 100, ma20: 100, close: 90, score: 99, available: true, returns: {r1:1,r3:1,r5:1} }];
  const review = buildProfessionalReviewSnapshot(input);
  assert.equal(review.decision.marketGate, "blocked");
  assert.equal(review.decision.status, "blocked");
  assert.ok(review.decision.steps[1].facts.some(text => /MA60/.test(text)));
});

test("same-day intraday, mismatched source dates and stale market observations remain unconfirmed",()=>{
  const make = () => ({generatedAt:"2026-09-30T08:00:00Z", emotion:{date:"2026-09-30",limitUpCount:0,limitDownCount:0}, market:{stockCount:100,upCount:0,downCount:0,flatCount:100}, indices:[{code:"000985",date:"2026-09-30",historyBars:65,ma60:100,ma20:100,close:110,score:99,available:true,returns:{r1:1,r3:1,r5:1}}],ladderPools:{failedPool:[],failedPoolAvailable:true}});
  const good=buildProfessionalReviewSnapshot(make());assert.equal(good.decision.marketGate,"open");
  assert.match(good.decision.steps[1].facts.join(" "),/上涨 0 \/ 下跌 0 \/ 平盘 100/);
  assert.doesNotMatch(good.decision.steps[3].facts.join(" "),/炸板池不可用/);
  for(const edit of [x=>x.generatedAt="2026-09-30T02:00:00Z",x=>x.emotion.date="2026-09-29",x=>{x.indices[0].date="2026-09-01";x.emotion.date="2026-09-01";}]){
    const input=make();edit(input);assert.equal(buildProfessionalReviewSnapshot(input).decision.marketGate,"unknown");
  }
});
test("negative and inconsistent breadth counts are not described as observed market breadth",()=>{
  for(const market of [{stockCount:100,upCount:-1,downCount:99,flatCount:2},{stockCount:100,upCount:80,downCount:80,flatCount:1},{stockCount:100,upCount:40.5,downCount:50,flatCount:9.5}]){
    const review=buildProfessionalReviewSnapshot({generatedAt:"2026-09-30T08:00:00Z",market});
    assert.match(review.decision.steps[0].facts.join(" "),/涨跌家数缺失|家数.*无效/);
    assert.doesNotMatch(review.decision.steps[1].facts.join(" "),/上涨 .*下跌/);
  }
});
test("invalid calendar dates in index history cannot establish a complete MA60",()=>{
  const rows=Array.from({length:70},(_,i)=>({date:new Date(Date.UTC(2026,6,23+i)).toISOString().slice(0,10),open:10+i*.05,high:11+i*.05,low:9+i*.05,close:10+i*.05,amount:200000000,volume:100000}));
  const index=rows.findIndex(row=>row.date==="2026-08-31");rows.splice(index+1,0,{...rows[index],date:"2026-08-32"});
  const review=buildProfessionalReviewSnapshot({generatedAt:"2026-09-30T08:00:00Z",indices:[{definition:{code:"000985",name:"合成指数"},chart:{rows}}]});
  assert.equal(review.decision.marketGate,"unknown");assert.equal(review.indices[0].historyValid,false);
});

test("professional review refresh propagates to every index chart request", async () => {
  const originals = Object.fromEntries([
    "getReviewIndexChart",
    "marketEmotionSnapshot",
    "wholeMarketSnapshot",
    "currentLadderPools",
    "getLimitUpSectorBoard",
    "discoverLimitUps"
  ].map((key) => [key, services[key]]));
  const chartRefreshFlags = [];
  try {
    services.getReviewIndexChart = async (_secid, options) => {
      chartRefreshFlags.push(options?.forceRefresh === true);
      return chart(100);
    };
    services.marketEmotionSnapshot = async () => ({
      date: "2026-08-10",
      limitUpCount: 0,
      limitDownCount: 0,
      previousLimitUpCount: 0,
      score: 50,
      state: "中性"
    });
    services.wholeMarketSnapshot = async () => ({
      stockCount: 1,
      upCount: 0,
      downCount: 0,
      flatCount: 1,
      breadth: 0.5,
      averageReturn: 0
    });
    services.currentLadderPools = async () => ({
      currentPool: [],
      previousPool: [],
      failedPool: [],
      failedPoolAvailable: true
    });
    services.getLimitUpSectorBoard = async () => [];
    services.discoverLimitUps = async () => ({
      rows: [],
      meta: { dataDate: "2026-08-10", fetchedAt: new Date().toISOString(), providers: [] }
    });
    resetProfessionalReviewCache();
    await getProfessionalReview({ refresh: true, settings: {} });
    assert.deepEqual(chartRefreshFlags, [true, true, true, true, true]);
  } finally {
    Object.assign(services, originals);
    resetProfessionalReviewCache();
  }
});


test("market evidence exposes verified breadth and aligned index measurements without synthetic sector confidence",()=>{
  const input={generatedAt:'2026-09-30T08:00:00Z',emotion:{date:'2026-09-30',limitUpCount:50,limitDownCount:5},market:{stockCount:100,upCount:60,downCount:35,flatCount:5},indices:[{code:'000985',name:'中证全指',date:'2026-09-30',historyBars:65,ma60:100,ma20:105,close:110,score:70,available:true,returns:{r1:1,r3:2,r5:3}}],sectors:[{name:'合成板块',poolLimitUps:8,relativeReturn:2}],ladderPools:{currentPool:[],failedPool:[],failedPoolAvailable:true}};
  const d=buildProfessionalReviewSnapshot(input).decision;
  assert.equal(d.metrics.find(m=>m.id==='breadth').value,60);
  assert.ok(Math.abs(d.metrics.find(m=>m.id==='ma60Distance').value-10)<1e-9);
  assert.equal(d.context.find(c=>c.id==='sector-0').state,'日期 / 覆盖待核');
  assert.match(d.context.find(c=>c.id==='sector-0').facts.join(' '),/8.*2.00/);
  assert.ok(d.evidence.every((e,i,all)=>!i||all[i-1].priority<=e.priority));
  input.emotion.limitUpCount=-1;input.market.upCount=150;
  const invalid=buildProfessionalReviewSnapshot(input).decision;
  assert.equal(invalid.metrics.find(m=>m.id==='breadth').value,null);
  assert.equal(invalid.metrics.find(m=>m.id==='limitUp').value,null);
});


test("a slow earlier market calculation cannot overwrite the cache after a newer refresh",async()=>{
 const keys=['getReviewIndexChart','marketEmotionSnapshot','wholeMarketSnapshot','currentLadderPools','getLimitUpSectorBoard','discoverLimitUps'];
 const originals=Object.fromEntries(keys.map(k=>[k,services[k]]));const resolves=[];
 try {
  services.getReviewIndexChart=async()=>chart(100);
  services.marketEmotionSnapshot=()=>new Promise(resolve=>resolves.push(resolve));
  services.wholeMarketSnapshot=async()=>({stockCount:1,upCount:1,downCount:0,flatCount:0});
  services.currentLadderPools=async()=>({currentPool:[],previousPool:[],failedPool:[]});
  services.getLimitUpSectorBoard=async()=>[];services.discoverLimitUps=async()=>({rows:[]});
  resetProfessionalReviewCache();
  const older=getProfessionalReview();const newer=getProfessionalReview({refresh:true});
  resolves[1]({date:'2026-09-30',limitUpCount:20,limitDownCount:1});await newer;
  resolves[0]({date:'2026-09-30',limitUpCount:5,limitDownCount:1});await older;
  const cached=await getProfessionalReview();assert.equal(cached.emotion.limitUpCount,20);
 } finally {Object.assign(services,originals);resetProfessionalReviewCache();}
});

test('cold professional review callers share one aggregate and isolate settings identities', async () => {
  const keys = ['getReviewIndexChart', 'marketEmotionSnapshot', 'wholeMarketSnapshot', 'currentLadderPools', 'getLimitUpSectorBoard', 'discoverLimitUps'];
  const originals = Object.fromEntries(keys.map(key => [key, services[key]]));
  const counts = Object.fromEntries(keys.map(key => [key, 0]));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    services.getReviewIndexChart = async () => { counts.getReviewIndexChart++; await gate; return chart(100); };
    services.marketEmotionSnapshot = async settings => { counts.marketEmotionSnapshot++; await gate; return { date: '2026-09-30', limitUpCount: settings.provider === 'ths' ? 20 : 5 }; };
    services.wholeMarketSnapshot = async () => { counts.wholeMarketSnapshot++; await gate; return {}; };
    services.currentLadderPools = async () => { counts.currentLadderPools++; await gate; return {}; };
    services.getLimitUpSectorBoard = async () => { counts.getLimitUpSectorBoard++; await gate; return []; };
    services.discoverLimitUps = async () => { counts.discoverLimitUps++; await gate; return { rows: [] }; };
    resetProfessionalReviewCache();
    const jobs = Array.from({ length: 5 }, () => getProfessionalReview({ settings: { provider: 'eastmoney' } }));
    release();
    const results = await Promise.all(jobs);
    assert.equal(counts.marketEmotionSnapshot, 1);
    assert.equal(counts.getReviewIndexChart, 5);
    assert.equal(results.every(result => result === results[0]), true);
    const changed = await getProfessionalReview({ settings: { provider: 'ths' } });
    assert.equal(changed.emotion.limitUpCount, 20);
    assert.equal(counts.marketEmotionSnapshot, 2);
  } finally { release(); Object.assign(services, originals); resetProfessionalReviewCache(); }
});

test('reset fences old review completion and forced refresh calls share their new generation', async () => {
  const keys = ['getReviewIndexChart', 'marketEmotionSnapshot', 'wholeMarketSnapshot', 'currentLadderPools', 'getLimitUpSectorBoard', 'discoverLimitUps'];
  const originals = Object.fromEntries(keys.map(key => [key, services[key]]));
  const resolves = [];
  try {
    services.getReviewIndexChart = async () => chart(100);
    services.marketEmotionSnapshot = () => new Promise(resolve => resolves.push(resolve));
    services.wholeMarketSnapshot = async () => ({});
    services.currentLadderPools = async () => ({});
    services.getLimitUpSectorBoard = async () => [];
    services.discoverLimitUps = async () => ({ rows: [] });
    resetProfessionalReviewCache();
    const old = getProfessionalReview({ refresh: true });
    resetProfessionalReviewCache();
    const fresh = getProfessionalReview({ refresh: true });
    const duplicate = getProfessionalReview({ refresh: true });
    assert.equal(resolves.length, 2);
    resolves[1]({ date: '2026-09-30', limitUpCount: 20 }); await Promise.all([fresh, duplicate]);
    resolves[0]({ date: '2026-09-30', limitUpCount: 5 }); await old;
    assert.equal((await getProfessionalReview()).emotion.limitUpCount, 20);
  } finally {
    for (const resolve of resolves) resolve({ date: '2026-09-30', limitUpCount: 0 });
    Object.assign(services, originals); resetProfessionalReviewCache();
  }
});

test('nested settings identities stay distinct and repeated reset cannot evade active aggregate admission', async () => {
  const keys = ['getReviewIndexChart', 'marketEmotionSnapshot', 'wholeMarketSnapshot', 'currentLadderPools', 'getLimitUpSectorBoard', 'discoverLimitUps'];
  const originals = Object.fromEntries(keys.map(key => [key, services[key]]));
  let release, gated = false, started = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const jobs = [];
  try {
    services.getReviewIndexChart = async () => chart(100);
    services.marketEmotionSnapshot = async settings => { started++; if (gated) await gate; return { date: '2026-09-30', limitUpCount: settings.policy?.mode === 'one' ? 5 : 20 }; };
    services.wholeMarketSnapshot = async () => ({});
    services.currentLadderPools = async () => ({});
    services.getLimitUpSectorBoard = async () => [];
    services.discoverLimitUps = async () => ({ rows: [] });
    resetProfessionalReviewCache();
    await getProfessionalReview({ settings: { policy: { mode: 'one' } } });
    assert.equal((await getProfessionalReview({ settings: { policy: { mode: 'two' } } })).emotion.limitUpCount, 20);
    gated = true; started = 0;
    for (let index = 0; index < 10; index++) {
      resetProfessionalReviewCache();
      jobs.push(getProfessionalReview().then(value => ({ value }), error => ({ error })));
    }
    assert.equal(started, 4, 'reset invalidates identities but must retain physical ownership');
    release();
    const results = await Promise.all(jobs);
    assert.equal(results.filter(row => row.error?.code === 'SERVICE_BUSY').length, 6);
    resetProfessionalReviewCache();
    assert.ok(await getProfessionalReview(), 'completed old work must release admission');
  } finally { release(); await Promise.allSettled(jobs); Object.assign(services, originals); resetProfessionalReviewCache(); }
});

// Keep the real review -> chart normalization -> cache -> provider URL path.
// Only external JSON delivery and unrelated review aggregates are replaced.
function offlineReviewServices({ tencentFallback = false } = {}) {
  const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
  const { createRequire } = require('node:module');
  const urls = [];
  const load = (name, overrides = {}) => {
    const filename = path.join(__dirname, name), actual = createRequire(filename), module = { exports: {} };
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports,
      require: id => overrides[id] || actual(id), __dirname, __filename: filename, process, console,
      URL, DOMException, AbortController, AbortSignal, TextDecoder, Buffer, setTimeout, clearTimeout,
      setImmediate, queueMicrotask }, { filename });
    return module.exports;
  };
  const service = load('services.cjs', { './http-client.cjs': { fetchJsonWithPolicy: async url => {
    const endpoint = new URL(url); urls.push(endpoint);
    if (tencentFallback && endpoint.hostname === 'web.ifzq.gtimg.cn') {
      assert.equal(endpoint.searchParams.get('param'), 'sh000001,day,,,210,');
      return { data: { sh000001: { day: Array.from({length:90}, (_, i) =>
        [new Date(Date.UTC(2026,6,1+i)).toISOString().slice(0,10), '3100', '3100', '3101', '3099', '1000']) } } };
    }
    assert.equal(endpoint.pathname, '/api/qt/stock/kline/get');
    if (tencentFallback) return { data: { klines: [] } };
    const close = endpoint.searchParams.get('secid') === '0.000001' ? 12 : 3100;
    return { data: { klines: Array.from({length: 90}, (_, i) =>
      `${new Date(Date.UTC(2026, 6, 1+i)).toISOString().slice(0,10)},${close},${close},${close+1},${close-1},1000,10000000,0,0,0,0`) } };
  } } });
  Object.assign(service, {
    marketEmotionSnapshot: async () => null, wholeMarketSnapshot: async () => null,
    currentLadderPools: async () => ({}), getLimitUpSectorBoard: async () => [],
    discoverLimitUps: async () => ({ rows: [] })
  });
  return { service, review: load('review-service.cjs', { './services.cjs': service }), urls };
}

test('professional review loads all five real index identities through chart caches and keeps stock 000001 separate', async () => {
  const { service, review, urls } = offlineReviewServices();
  const snapshot = await review.getProfessionalReview();
  assert.equal(snapshot.indices.length, 5);
  assert.ok(snapshot.indices.every(index => index.available && index.historyBars === 90 && index.ma60 === 3100));
  assert.deepEqual(urls.map(url => url.searchParams.get('secid')).sort(), ['0.399001','0.399006','1.000001','1.000300','1.000985']);
  assert.ok(urls.every(url => url.searchParams.get('fqt') === '0'), 'index prices have no corporate-action adjustment');
  const index = await service.getReviewIndexChart('1.000001', { limit: 90, adjustment: 2 });
  const stock = await service.getChart({code:'000001', secid:'0.000001', thscode:'000001.SZ'}, '101', {limit:90, adjustment:0});
  assert.equal(index.rows.at(-1).close, 3100);
  assert.equal(stock.rows.at(-1).close, 12);
  assert.equal(urls.length, 6, 'index repeated request must hit cache independently of the bank');
  for (const method of ['getChart','getQuoteSnapshot','analyzeSecurity']) {
    await assert.rejects(service[method]({code:'000001',secid:'1.000001',thscode:'000001.SH'}), /Invalid secid/);
    await assert.rejects(service[method]({code:'000001',secid:'1.000001',thscode:'000001.SH',assetType:'index'}), /Unsupported/);
  }
  await assert.rejects(service.getReviewIndexChart('0.000001'), /Unsupported.*index/);
  assert.equal(urls.length, 6, 'rejected identities must never reach the provider');
});


test('review index fallback keeps Shanghai identity and unadjusted prices when the primary has no bars', async () => {
  const { service, urls } = offlineReviewServices({ tencentFallback: true });
  const result = await service.getReviewIndexChart('1.000001', { limit: 90 });
  assert.equal(result.rows.at(-1).close, 3100);
  assert.equal(result.dataSource, 'tencent_unadjusted');
  assert.equal(result.adjustment, '不复权');
  assert.equal(result.rows[0].amount, null, 'price-only fallback does not invent turnover evidence');
  assert.deepEqual(urls.map(url => url.hostname), ['push2his.eastmoney.com', 'web.ifzq.gtimg.cn']);
});
