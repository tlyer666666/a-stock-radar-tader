"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let restoreTypeScript;
let ProfessionalReview;
let FACTOR_GROUPS;
let buildStockReviewDecision, stockReviewFromPayload, DecisionReview;

before(() => {
  restoreTypeScript = registerTypeScript();
  ({ default: ProfessionalReview, FACTOR_GROUPS, buildStockReviewDecision, stockReviewFromPayload, DecisionReview } = require("./ProfessionalReview.tsx"));
});

function stockFixture() {
  const history = Array.from({length:70}, (_,i) => { const close=10+i*.05; return {date:new Date(Date.UTC(2026,6,23+i)).toISOString().slice(0,10),open:close-.02,high:close+.08,low:close-.08,close,volume:1000000,amount:200000000}; });
  return { security:{code:"600001",name:"合成测试证券",assetType:"stock"}, quote:{latest:history.at(-1).close,amount:200000000}, history,
    actualProvider:"synthetic-test", updatedAt:"2026-09-30T08:00:00Z", analysis:{mrs:99,maBull:true,slopesUp:true,limitEvent:{date:history.at(-8).date,low:history.at(-8).low},rsSector:2,historicalEdge:{sampleCount:100,winRate5:99,average5:12},qualification:{riskVetoPassed:true}}, sector:{name:"合成行业"} };
}
test("ordered stock review preserves observed trend but never invents missing risk prices or market confirmation", () => {
  const payload=stockFixture();
  const decision=buildStockReviewDecision(payload);
  assert.equal(decision.marketGate,"unknown");
  assert.equal(decision.stage,"趋势延续观察");
  assert.equal(decision.canPlan,false);
  assert.equal(decision.levels.stop,null);assert.equal(decision.levels.target,null);
  assert.deepEqual(decision.steps.map(s=>s.id),["data","market","stock","conflicts","next"]);
  const altered=structuredClone(payload);altered.analysis.mrs=1;altered.analysis.historicalEdge.winRate5=0;
  assert.equal(buildStockReviewDecision(altered).stage,decision.stage,"old scores and 5-day wins are not independent trend votes");
  const stock=stockReviewFromPayload(payload);
  assert.equal(stock.factors.length,20);
  assert.equal(stock.plan.stop,null);assert.equal(stock.plan.target,null);
});
test("missing, future or duplicate daily bars cannot establish an actionable stock phase", () => {
  for (const mutate of [p=>p.history=[],p=>p.history.push({...p.history.at(-1),date:"2026-10-01"}),p=>p.history[20].date=p.history[19].date,p=>p.history[10].date="2026-99-99",p=>p.history[10].low=999]) {
    const payload=stockFixture();mutate(payload);
    const decision=buildStockReviewDecision(payload);
    assert.equal(decision.status,"insufficient");assert.equal(decision.canPlan,false);
  }
});
test("intraday observations and mismatched market dates never become confirmed context",()=>{
  const payload=stockFixture();payload.updatedAt="2026-09-30T03:00:00Z";
  const decision=buildStockReviewDecision(payload,{decision:{asOf:"2026-09-30",marketGate:"open"}});
  assert.equal(decision.stage,"趋势延续观察");assert.equal(decision.status,"watch");
  assert.match(decision.steps[0].state,/盘中/);
  assert.equal(buildStockReviewDecision(payload,{decision:{asOf:"2026-09-29",marketGate:"open"}}).marketGate,"unknown");
  assert.equal(decision.canPlan,false);
});
test("explicit ST status is a veto even when the display name has no ST marker",()=>{
  for(const location of ["security","quote"]){
    const payload=stockFixture();payload[location].isST=true;
    assert.equal(buildStockReviewDecision(payload,{decision:{asOf:payload.history.at(-1).date,marketGate:"open"}}).status,"blocked");
  }
});
test("an intraday break is provisional, not a confirmed closing-price invalidation",()=>{
  const payload=stockFixture();payload.updatedAt="2026-09-30T03:00:00Z";payload.history.at(-1).close=10;payload.history.at(-1).low=9.9;
  const decision=buildStockReviewDecision(payload,{decision:{asOf:payload.history.at(-1).date,marketGate:"open"}});
  assert.equal(decision.status,"watch");
  assert.match(decision.steps.find(s=>s.id==="conflicts").facts.join(" "),/盘中.*待收盘/);
  assert.doesNotMatch(decision.steps.find(s=>s.id==="conflicts").facts.join(" "),/原结构失效/);
});
test("old bars and a matching old market snapshot remain historical observations",()=>{
  const payload=stockFixture();
  payload.history.forEach(row=>row.date=new Date(Date.parse(row.date)-29*86400000).toISOString().slice(0,10));
  payload.analysis.limitEvent.date=payload.history.at(-8).date;
  const decision=buildStockReviewDecision(payload,{generatedAt:"2026-09-01T08:00:00Z",decision:{asOf:"2026-09-01",marketGate:"open"}});
  assert.equal(decision.status,"watch");assert.equal(decision.marketGate,"unknown");
  assert.match(decision.steps[0].facts.join(" "),/陈旧/);
  assert.equal(decision.stage,"趋势延续观察","retain the observed historical trend");
});
test("an observed anchor break and upstream risk facts stay visible",()=>{
  const payload=stockFixture();payload.history.at(-1).close=10;payload.history.at(-1).low=9.9;
  payload.analysis.risks=["合成待核公告风险"];
  const decision=buildStockReviewDecision(payload);
  assert.equal(decision.status,"blocked");
  assert.match(decision.steps.find(s=>s.id==="conflicts").facts.join(" "),/原结构失效.*合成待核公告风险/);
});
test("market rule rejection and unsupported assets remain distinct from missing evidence",()=>{
  const payload=stockFixture();const market={date:payload.history.at(-1).date,decision:{asOf:payload.history.at(-1).date,marketGate:"blocked"}};
  assert.equal(buildStockReviewDecision(payload,market).status,"blocked");
  payload.security.name="*ST合成";
  assert.equal(buildStockReviewDecision(payload).status,"blocked");
});
test("non A-share codes are out of scope while the 920 Beijing code family stays eligible",()=>{
  const payload=stockFixture();const market={decision:{asOf:payload.history.at(-1).date,marketGate:"open"}};
  for(const code of ["AAPL","00700","510300","100001",""]){payload.security.code=code;assert.equal(buildStockReviewDecision(payload,market).status,"blocked");}
  payload.security.code="920001";assert.equal(buildStockReviewDecision(payload,market).status,"conditional");
});
test("ordered summary has five evidence steps and no probability or position recommendation",()=>{
  const html=renderToStaticMarkup(React.createElement(DecisionReview,{decision:buildStockReviewDecision(stockFixture())}));
  for(const text of ["数据是否可用","市场与板块","阶段与关键证据","冲突与失效","次日条件情景"])assert.ok(html.includes(text));
  assert.doesNotMatch(html,/胜率|\/100|建议仓位|60%–80%/);
});

test("professional stock review keeps the complete five-group twenty-factor contract", () => {
  assert.equal(FACTOR_GROUPS.length, 5);
  const factors = FACTOR_GROUPS.flatMap((group) => group.factors);
  assert.equal(factors.length, 20);
  assert.equal(new Set(factors).size, factors.length);
});

after(() => restoreTypeScript?.());

test("professional review renders its critical navigation shell", () => {
  const html = renderToStaticMarkup(React.createElement(ProfessionalReview));
  assert.match(html, /<h1>专业复盘<\/h1>/);
  assert.match(html, /市场复盘/);
  assert.match(html, /个股复盘/);
  assert.match(html, /复盘档案 0/);
  assert.match(html, /aria-label="专业复盘页面"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.match(html, /重新计算/);
});


test("deep stock evidence uses observed windows, missing turnover stays missing and contradictions are ranked",()=>{
  const payload=stockFixture();payload.history.at(-1).volume=2000000;
  const result=buildStockReviewDecision(payload);
  assert.equal(result.metrics.find(m=>m.id==='volumeRatio20').value,2);
  assert.ok(Math.abs(result.metrics.find(m=>m.id==='return20').value-(13.45/12.45-1)*100)<1e-9);
  const anchor=result.observedLevels.find(l=>l.id==='eventLow');
  assert.equal(anchor.price,payload.history.at(-8).low);assert.equal(anchor.asOf,payload.history.at(-8).date);
  assert.ok(result.evidence.every((e,i,all)=>!i||all[i-1].priority<=e.priority));
  assert.equal(result.context.find(c=>c.id==='sector').state,'口径待核');
  assert.equal(result.scenarios.length,3);assert.ok(result.scenarios.every(s=>s.confirmation&&s.invalidation));
  delete payload.history[55].amount;delete payload.history[55].volume;
  const missing=buildStockReviewDecision(payload);
  assert.equal(missing.metrics.find(m=>m.id==='volumeRatio20').value,null);
  assert.equal(missing.metrics.find(m=>m.id==='amount20').value,null);
  assert.equal(missing.stage,'趋势延续观察','missing flow does not erase valid price evidence');
});
test("invalid prices never leak into richer observations and an adverse structure outranks unverified context",()=>{
  const p=stockFixture();p.history.at(-1).close=10;p.history.at(-1).low=9.9;
  const result=buildStockReviewDecision(p);
  assert.equal(result.evidence[0].tone,'risk');
  assert.match(result.evidence[0].detail,/结构失效/);
  p.history[10].close=NaN;
  const invalid=buildStockReviewDecision(p);
  assert.ok(invalid.metrics.every(m=>m.value===null));
  assert.ok(invalid.observedLevels.every(l=>l.price===null));
  assert.doesNotMatch(JSON.stringify(invalid),/NaN|Infinity/);
});
test("rich decision UI exposes actual evidence and observations outside legacy score details",()=>{
  const html=renderToStaticMarkup(React.createElement(DecisionReview,{decision:buildStockReviewDecision(stockFixture())}));
  for(const text of ['结构实测','观察价位','反证优先','市场与板块背景','20 根涨跌','涨停锚点低点','确认依据','失效观察'])assert.ok(html.includes(text),text);
  assert.doesNotMatch(html,/胜率|建议仓位|\/100/);
});

test('blank and non-numeric market/execution evidence remain unavailable rather than becoming zero scores', () => {
  for (const missing of [null, '   ', false, true, [], {}]) {
    const payload = stockFixture();
    payload.analysis.marketScore = missing;
    payload.analysis.executionReadiness = {score: missing};
    payload.analysis.infoScore = missing;
    const stock = stockReviewFromPayload(payload);
    for (const id of ['market', 'execution', 'information']) {
      assert.equal(stock.factors.find(f => f.id === id).available, false, `${id}: ${JSON.stringify(missing)}`);
    }
  }
});


test('genuine numeric zero and numeric text remain available as observed evidence', () => {
  for (const observed of [0, '0', 42, ' 42.5 ']) {
    const payload = stockFixture();
    payload.analysis.marketScore = observed;
    payload.analysis.executionReadiness = {score: observed};
    payload.analysis.infoScore = observed;
    const stock = stockReviewFromPayload(payload);
    for (const id of ['market', 'execution', 'information']) assert.equal(stock.factors.find(f => f.id === id).available, true, id);
  }
});

function archiveRecord(snapshot, type = 'stock') {
  return {id:'synthetic-record',type,title:'合成档案',date:'2026-10-01',score:50,verdict:'观察',note:'',createdAt:'2026-10-01T00:00:00Z',snapshot};
}

test('archive boundary accepts generated and legacy snapshots without altering historical evidence', () => {
  const {isReviewRecord} = require('./reviewArchive.ts');
  const current = archiveRecord(stockReviewFromPayload(stockFixture()));
  const before = JSON.stringify(current);
  assert.equal(isReviewRecord(current),true);
  const legacy = structuredClone(current);
  for(const key of ['decision','diagnostics','keyLevels','factorLeaders','checklist','scenarios','factorEngine','certainty']) delete legacy.snapshot[key];
  assert.equal(isReviewRecord(legacy),true,'omitted legacy evidence remains restorable without current-data recomputation');
  const market = require('../electron/review-service.cjs').buildProfessionalReviewSnapshot({generatedAt:'2026-10-01T08:00:00Z'});
  assert.equal(isReviewRecord(archiveRecord(market,'market')),true);
  const oldMarket = structuredClone(market);delete oldMarket.decision;
  assert.equal(isReviewRecord(archiveRecord(oldMarket,'market')),true);
  assert.equal(JSON.stringify(current),before);
});

test('detailed stock archives cannot bypass required containers or inject render objects anywhere in displayed evidence', () => {
  const {isReviewRecord} = require('./reviewArchive.ts');
  const paths = [
    ['factors', [null]], ['checklist.confirmed', null], ['security.name', {bad:true}],
    ['quote.industry', {bad:true}], ['analysis.exactNode', {bad:true}], ['factorEngine.note', {bad:true}],
    ['certainty.label', {bad:true}], ['evidence', [null]], ['risks', [{bad:true}]], ['plan.invalidations', {}],
    ['factorLeaders.risk', null], ['keyLevels', [null]], ['diagnostics.maxDrawdownLabel', {}], ['scenarios', [null]],
    ['decision.steps', [null]], ['decision.steps.0.facts', null], ['decision.context.0.facts', {}], ['decision.metrics', [null]],
    ['decision.observedLevels.0.label', {}], ['decision.evidence', [null]], ['decision.scenarios', {}], ['decision.limitations', [null]],
    ['factorEngine', undefined], ['factors', undefined], ['evidence', undefined], ['risks', undefined], ['plan', undefined], ['plan.invalidations', undefined]
  ];
  for(const [path,value] of paths){
    const candidate=archiveRecord(stockReviewFromPayload(stockFixture()));const parts=path.split('.');const leaf=parts.pop();let parent=candidate.snapshot;
    for(const part of parts)parent=parent[part]; if(value===undefined)delete parent[leaf];else parent[leaf]=value;
    assert.equal(isReviewRecord(candidate),false,path);
  }
});

test('market archive boundary covers market/ecology, index returns and every mapped display collection', () => {
  const {isReviewRecord} = require('./reviewArchive.ts');
  const build = () => require('../electron/review-service.cjs').buildProfessionalReviewSnapshot({generatedAt:'2026-10-01T08:00:00Z'});
  for(const [path,value] of [
    ['market', null], ['ecology', null], ['market.upCount', {}], ['regime.name', {}], ['indices', [null]],
    ['indices', [{name:'合成',returns:null}]], ['focusSectors', [null]], ['leaders', [{name:{bad:true}}]],
    ['evidence', {}], ['riskSignals', [null]], ['scenarios', [{name:'合成',conditions:null}]],
    ['nextPlan.focus', {}], ['sources', {}], ['methodology.note', {}], ['decision.steps', null]
  ]){
    const candidate=archiveRecord(build(),'market');const parts=path.split('.');const leaf=parts.pop();let parent=candidate.snapshot;
    for(const part of parts)parent=parent[part];parent[leaf]=value;assert.equal(isReviewRecord(candidate),false,path);
  }
});
