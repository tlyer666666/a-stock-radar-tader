"use strict";
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const restore = registerTypeScript();
after(() => restore?.());
const model = require("./aiSelectionModel.ts");

test("AI input takes the top summary rows with only the fields the model needs", () => {
  const rows = Array.from({ length: 50 }, (_, i) => ({ code: String(600000 + i), name: `股${i}`, strategies: [{ id: "a", name: "首板" }, { id: "b", name: "回踩" }],
    executionNotes: ["n1", "n2", "n3", "n4", "n5"], familyCount: 2, signalStrength: 70 - i }));
  const picks = model.buildAiPicks(rows);
  assert.equal(picks.length, 40);
  assert.deepEqual(picks[0].strategies, ["首板", "回踩"]);
  assert.equal(picks[0].notes.length, 4);
  assert.equal(picks[0].familyCount, undefined);
});

test("AI score sorting puts scored stocks first by score and keeps the original order for the rest", () => {
  const scores = model.aiScoreMap({ items: [{ code: "600002", score: 50 }, { code: "600003", score: 90 }] });
  const sorted = model.sortByAiScore([{ code: "600001" }, { code: "600002" }, { code: "600003" }, { code: "600004" }], scores);
  assert.deepEqual(sorted.map(row => row.code), ["600003", "600002", "600001", "600004"]);
  assert.equal(model.ratingTone("重点关注"), "strong");
  assert.equal(model.aiErrorMessage(new Error("Error invoking remote method 'ai:rank': Error: AI 接口限流")), "AI 接口限流");
});

test("AI board shows scored stocks by score, then unscored candidates; rating filters only scored rows", () => {
  const sources = [{ code: "600001", name: "甲" }, { code: "600002", name: "乙" }, { code: "600003", name: "丙" }];
  const ranking = { items: [{ code: "600003", name: "丙", score: 82, rating: "重点关注" }, { code: "600001", name: "甲", score: 45, rating: "观望" }] };
  assert.deepEqual(model.buildAiBoardRows(sources, ranking).map(row => [row.code, row.ai?.score ?? null]), [["600003", 82], ["600001", 45], ["600002", null]]);
  assert.deepEqual(model.buildAiBoardRows(sources, ranking, "观望").map(row => row.code), ["600001"]);
  assert.deepEqual(model.buildAiBoardRows(sources, null).map(row => row.code), ["600001", "600002", "600003"]);
  assert.equal(model.buildAiBoardRows([], ranking)[0].source, undefined, "history rows work without the selection rows");
  assert.equal(model.secidFor("600001"), "1.600001");
  assert.equal(model.secidFor("000001"), "0.000001");
});

test("the latest selection result and a plain-language strategy request are shared between pages", () => {
  const store = require("./selectionReportStore.ts");
  let seen = 0;
  const stop = store.subscribeSelectionReport(() => { seen += 1; });
  store.setSelectionReport({ asOfDate: "2026-11-02", strategies: [] });
  assert.equal(store.getSelectionReport().asOfDate, "2026-11-02");
  assert.equal(seen, 1);
  stop();
  store.setSelectionReport(null);
  assert.equal(seen, 1);
  store.setPendingStrategyText("  近一周首板，缩量回踩  ");
  assert.equal(store.takePendingStrategyText(), "近一周首板，缩量回踩");
  assert.equal(store.takePendingStrategyText(), "", "the request is handed over only once");
});

test("my-stocks list merging dedupes, caps at 40 and explains what happened", () => {
  const custom = require("../ai-picks/aiCustomModel.ts");
  const start = [{ code: "600001", name: "甲" }];
  const result = custom.mergeCustomStocks(start, [{ code: "600001" }, { code: "600002", name: " 乙 股份 " }, { code: "abc" }]);
  assert.deepEqual(result.list.map(item => item.code), ["600001", "600002"]);
  assert.equal(result.list[1].name, "乙股份");
  assert.equal(custom.mergeNotice("持仓", result), "从持仓加入 1 只，1 只已在清单里。");
  const full = custom.mergeCustomStocks([], Array.from({ length: 45 }, (_, i) => ({ code: String(600100 + i) })));
  assert.equal(full.list.length, 40);
  assert.equal(full.overflow, 5);
  assert.deepEqual(custom.profileFacts({ return5: 3.2, return20: -1, volumeRatio: 1.5, trend: "站上全部均线", consecutiveBoards: 2, limitUps20: 2 }),
    ["近5日 +3.20%", "近20日 -1.00%", "量比 1.50", "站上全部均线", "2连板", "近20日涨停 2 次"]);
});

test("removed or deleted stocks drop out of the board even when they were scored", () => {
  const ranking = { items: [{ code: "600003", name: "丙", score: 82, rating: "重点关注" }, { code: "600001", name: "甲", score: 45, rating: "观望" }] };
  const sources = [{ code: "600001", name: "甲" }, { code: "600002", name: "乙" }];
  assert.deepEqual(model.buildAiBoardRows(sources, ranking, "全部", true).map(row => row.code), ["600001", "600002"]);
  assert.deepEqual(model.buildAiBoardRows(sources, ranking, "全部").map(row => row.code), ["600003", "600001", "600002"], "history keeps every scored stock");
});

test("the score button scores the ticked stocks, then the unscored ones, then everything again", () => {
  const { scoreAction } = require("../ai-picks/AiRowSelection.tsx");
  const total = ["600001", "600002", "600003"];
  assert.deepEqual(scoreAction({ selected: ["600002"], scored: new Set(["600001"]), total }), { label: "给勾选的 1 只打分", force: true, only: ["600002"] });
  assert.deepEqual(scoreAction({ selected: [], scored: new Set(), total }), { label: "AI 打分", force: false, only: undefined });
  assert.deepEqual(scoreAction({ selected: [], scored: new Set(["600001"]), total }), { label: "给未打分的 2 只打分", force: false, only: undefined });
  assert.deepEqual(scoreAction({ selected: [], scored: new Set(total), total }), { label: "全部重新打分", force: true, only: undefined });
});

test("AI 点评 (看点 / 风险 / 次日关注) is rendered in full on a row spanning the table", () => {
  const React = require("react");
  const { renderToStaticMarkup } = require("react-dom/server");
  const { AiCommentRow } = require("../ai-picks/AiCommentRow.tsx");
  const risk = "当日跌6.9%跌破20日线，MACD红柱缩小，市场情绪偏弱需防继续回落";
  const html = renderToStaticMarkup(React.createElement("table", null, React.createElement("tbody", null,
    React.createElement(AiCommentRow, { ai: { highlights: "缩量回调守10日线", risks: risk, nextDay: "看能否站回5日线", reason: "破位扣分" }, colSpan: 7, extra: { label: "体检数据", text: "MA60 下方 12%" } }))));
  assert.match(html, /<td colSpan="7">/);
  assert.ok(html.includes(risk), "the whole risk text is present");
  assert.deepEqual([...html.matchAll(/<b>([^<]+)<\/b>/g)].map(m => m[1]), ["体检数据", "看点", "风险", "次日关注"]);
  assert.match(html, /AI 调分：破位扣分/);
  assert.equal(renderToStaticMarkup(React.createElement(AiCommentRow, { ai: null, colSpan: 3 })), "", "no empty row for unscored stocks");
});

function customBoardHarness(t, api, stockApi = {}) {
  const { createHookHarness, button } = require('../../../qa/research-hook-harness.cjs');
  const original = global.window;
  global.window = { stockApi: { ai: api, ...stockApi }, setTimeout, clearTimeout };
  const props = { configured: false, reload: 0, live: false };
  const { AiCustomBoard } = require('../ai-picks/AiCustomBoard.tsx');
  const h = createHookHarness(AiCustomBoard, { props });
  t.after(() => { h.dispose(); global.window = original; });
  h.render();
  return { h, props, button };
}
const deferredList = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };

test('rapid stock imports are saved serially against the last accepted collection', async t => {
  const saves = [];
  const api = { customList: async () => [{code:'600001',name:'甲'}], saveCustomList: items => {
    const pending=deferredList(); saves.push({items,pending}); return pending.promise;
  } };
  const {h,button}=customBoardHarness(t,api,{ getHoldings:async()=>[{code:'600002',name:'乙'}], getWatchlist:async()=>[{code:'600003',name:'丙'}] });
  await h.flush();
  button(h.tree,'导入持仓').props.onClick(); button(h.tree,'导入观察池').props.onClick(); await h.flush();
  assert.equal(saves.length,1,'the second write waits for the first acknowledgement');
  saves[0].pending.resolve(saves[0].items); await h.flush();
  assert.deepEqual(saves[1].items.map(x=>x.code),['600001','600002','600003']);
  saves[1].pending.resolve(saves[1].items); await h.flush();
});

test('a delayed list reload cannot overwrite a newer acknowledged mutation', async t => {
  const pending=deferredList(); let reads=0;
  const api={customList:()=>++reads===1?Promise.resolve([{code:'600001',name:'甲'}]):pending.promise,saveCustomList:async items=>items};
  const {h,props,button}=customBoardHarness(t,api,{getHoldings:async()=>[{code:'600002',name:'乙'}]});
  await h.flush(); props.reload++;h.render();
  button(h.tree,'导入持仓').props.onClick();await h.flush();
  pending.resolve([{code:'600001',name:'甲'}]);await h.flush();
  const {text}=require('../../../qa/research-hook-harness.cjs');
  assert.match(text(h.tree),/600002/);
});

test('a failed collection read cannot turn an existing list into an empty replacement', async t => {
  let writes=0;
  const {h,button}=customBoardHarness(t,{customList:async()=>{throw Error('读取失败');},saveCustomList:async items=>{writes++;return items;}},{getHoldings:async()=>[{code:'600002',name:'乙'}]});
  await h.flush();button(h.tree,'导入持仓').props.onClick();await h.flush();
  assert.equal(writes,0);
  const {text}=require('../../../qa/research-hook-harness.cjs');assert.match(text(h.tree),/读取|加载/);
});

test('a successful list retry clears the earlier read failure', async t => {
  let reads = 0;
  const {h,props} = customBoardHarness(t, {
    customList: async () => { if (++reads === 1) throw Error('temporary read failure'); return [{code:'600001',name:'甲'}]; },
    saveCustomList: async items => items
  });
  const {text} = require('../../../qa/research-hook-harness.cjs');
  await h.flush(); assert.match(text(h.tree), /清单读取失败/);
  props.reload++; h.render(); await h.flush();
  assert.match(text(h.tree), /600001/);
  assert.doesNotMatch(text(h.tree), /清单读取失败/);
});

function asyncPanelHarness(t, modulePath, exportName, props, api) {
  const { createHookHarness, button, text } = require('../../../qa/research-hook-harness.cjs');
  const original = global.window;
  global.window = { stockApi: { ai: api }, setTimeout, clearTimeout, setInterval, clearInterval };
  const Component = require(modulePath)[exportName];
  const h = createHookHarness(Component, { props });
  t.after(() => { h.dispose(); global.window = original; });
  h.render();
  return {h, button, text};
}

for (const scenario of [
  {name:'stock review', path:'../ai-picks/AiStockReviewPanel.tsx', component:'AiStockReviewPanel', props:()=>({security:{code:'600001',name:'甲'}}),
    change:props=>{props.security={code:'600002',name:'乙'};}, method:'review', cache:'cachedReview', label:'AI 点评', busy:'AI 点评中…', empty:null},
  {name:'page interpretation', path:'../ai-review/AiInterpretPanel.tsx', component:'AiInterpretPanel', props:()=>({kind:'limit-ecology',asOfDate:'2026-11-03',getData:()=>({})}),
    change:props=>{props.asOfDate='2026-11-04';}, method:'interpret', cache:'cachedInterpret', label:'AI 解读', busy:'解读中…', empty:null},
  {name:'market review', path:'../ai-review/AiMarketReviewPanel.tsx', component:'AiMarketReviewPanel', props:()=>({asOfDate:'2026-11-03'}),
    change:props=>{props.asOfDate='2026-11-04';}, method:'marketReview', cache:'cachedMarketReview', label:'AI 复盘', busy:'AI 调用技能分析中…', empty:{review:null,lookback:null,previousDate:''}}
]) {
  test(`${scenario.name} recovers controls on context change and ignores the old request's completion`, async t => {
    const first=deferredList(), second=deferredList(); let calls=0;
    const api={status:async()=>({configured:true}),[scenario.cache]:async()=>scenario.empty,
      [scenario.method]:()=>++calls===1?first.promise:second.promise,lookback:async()=>null};
    const props=scenario.props();
    const {h,button,text}=asyncPanelHarness(t,scenario.path,scenario.component,props,api);
    t.after(()=>{first.resolve(null);second.resolve(null);});
    await h.flush(); button(h.tree,scenario.label).props.onClick(); await h.flush();
    assert.equal(button(h.tree,scenario.busy).props.disabled,true);
    scenario.change(props);h.render();await h.flush();
    assert.equal(button(h.tree,scenario.label).props.disabled,false,'a new stock/date must be actionable');
    button(h.tree,scenario.label).props.onClick();await h.flush();
    first.reject(Error('old-context-failure'));await h.flush();
    assert.equal(button(h.tree,scenario.busy).props.disabled,true,'the old finally must not unlock the current request');
    assert.doesNotMatch(text(h.tree),/old-context-failure/);
    second.resolve(null);await h.flush();
    assert.equal(button(h.tree,scenario.label).props.disabled,false);
    assert.equal(calls,2);
  });
}

test('market review does not publish a completed request after its panel unmounts', async t => {
  const pending=deferredList(),published=[];
  const {h,button}=asyncPanelHarness(t,'../ai-review/AiMarketReviewPanel.tsx','AiMarketReviewPanel',
    {asOfDate:'2026-11-04',onReview:value=>published.push(value)},
    {status:async()=>({configured:true}),cachedMarketReview:async()=>({review:null,lookback:null,previousDate:''}),marketReview:()=>pending.promise,lookback:async()=>null});
  await h.flush();button(h.tree,'AI 复盘').props.onClick();await h.flush();
  h.dispose();const count=published.length;pending.resolve({headline:'late result'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(published.length,count,'an abandoned panel must not change the parent archive');
});

test('market review does not publish a delayed cache read after its panel unmounts', async t => {
  const pending=deferredList(),published=[];
  const {h}=asyncPanelHarness(t,'../ai-review/AiMarketReviewPanel.tsx','AiMarketReviewPanel',
    {asOfDate:'2026-11-04',onReview:value=>published.push(value)},
    {status:async()=>({configured:true}),cachedMarketReview:()=>pending.promise,marketReview:async()=>null,lookback:async()=>null});
  h.dispose();const count=published.length;pending.resolve({review:{headline:'late cached result'},lookback:null,previousDate:''});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(published.length,count);
});

test('page interpretation invalidates its request even when cached interpretation is unavailable', async t => {
  const pending=deferredList();const props={kind:'limit-ecology',asOfDate:'2026-11-03',getData:()=>({})};
  const {h,button,text}=asyncPanelHarness(t,'../ai-review/AiInterpretPanel.tsx','AiInterpretPanel',props,
    {status:async()=>({configured:true}),interpret:()=>pending.promise});
  await h.flush();button(h.tree,'AI 解读').props.onClick();await h.flush();props.asOfDate='2026-11-04';h.render();await h.flush();
  pending.reject(Error('old-context-failure'));await h.flush();
  assert.equal(button(h.tree,'AI 解读').props.disabled,false);assert.doesNotMatch(text(h.tree),/old-context-failure/);
});

test('AI candidates recover scoring after new selection data and a stale rank cannot end the next operation', async t => {
  const store=require('./selectionReportStore.ts');
  const makeReport=code=>({asOfDate:'2026-11-04',strategies:[{id:'sample',name:'样例',stocks:[{code,name:'样例股',signalStrength:70}]}]});
  const previous=store.getSelectionReport();store.setSelectionReport(makeReport('600001'));
  t.after(()=>store.setSelectionReport(previous));
  const first=deferredList(),second=deferredList();let calls=0;
  const {h,button,text}=asyncPanelHarness(t,'../ai-picks/AiPicksView.tsx','default',{live:false},
    {status:async()=>({configured:true}),cached:async()=>({rank:null,summary:null}),rank:()=>++calls===1?first.promise:second.promise});
  t.after(()=>{first.resolve({items:[]});second.resolve({items:[]});});
  await h.flush();button(h.tree,'AI 打分').props.onClick();await h.flush();
  store.setSelectionReport(makeReport('600002'));await h.flush();await h.flush();
  assert.equal(button(h.tree,'AI 打分').props.disabled,false);
  button(h.tree,'AI 打分').props.onClick();await h.flush();first.reject(Error('old-ranking-error'));await h.flush();
  assert.equal(button(h.tree,'AI 打分中…').props.disabled,true);assert.doesNotMatch(text(h.tree),/old-ranking-error/);
  second.resolve({items:[]});await h.flush();assert.equal(button(h.tree,'AI 打分').props.disabled,false);
});

test('a delayed page cache cannot replace an explicitly requested fresh interpretation', async t => {
  const cached=deferredList();
  const fresh={headline:'fresh-interpretation',title:'生态',asOfDate:'2026-11-04',model:'test',generatedAt:new Date().toISOString(),points:[],risks:[],watch:[]};
  const {h,button,text}=asyncPanelHarness(t,'../ai-review/AiInterpretPanel.tsx','AiInterpretPanel',
    {kind:'limit-ecology',asOfDate:'2026-11-04',getData:()=>({})},
    {status:async()=>({configured:true}),cachedInterpret:()=>cached.promise,interpret:async()=>fresh});
  await h.flush();button(h.tree,'AI 解读').props.onClick();await h.flush();assert.match(text(h.tree),/fresh-interpretation/);
  cached.resolve({...fresh,headline:'obsolete-cache'});await h.flush();
  assert.match(text(h.tree),/fresh-interpretation/);assert.doesNotMatch(text(h.tree),/obsolete-cache/);
});

test('a delayed stock cache cannot erase a fresh review', async t => {
  const cached=deferredList();
  const fresh={asOfDate:'2026-11-04',model:'test',generatedAt:new Date().toISOString(),items:[{code:'600001',name:'甲',score:60,rating:'关注',highlights:'fresh-stock-review'}]};
  const {h,button,text}=asyncPanelHarness(t,'../ai-picks/AiStockReviewPanel.tsx','AiStockReviewPanel',
    {security:{code:'600001',name:'甲'}},{status:async()=>({configured:true}),cachedReview:()=>cached.promise,review:async()=>fresh});
  await h.flush();button(h.tree,'AI 点评').props.onClick();await h.flush();assert.match(text(h.tree),/fresh-stock-review/);
  cached.resolve(null);await h.flush();assert.match(text(h.tree),/fresh-stock-review/);
});

test('a delayed market cache cannot erase a freshly published parent review', async t => {
  const cached=deferredList(),published=[];
  const {h,button}=asyncPanelHarness(t,'../ai-review/AiMarketReviewPanel.tsx','AiMarketReviewPanel',
    {asOfDate:'2026-11-04',onReview:value=>published.push(value)},
    {status:async()=>({configured:true}),cachedMarketReview:()=>cached.promise,marketReview:async()=>null,lookback:async()=>null});
  await h.flush();button(h.tree,'AI 复盘').props.onClick();await h.flush();const count=published.length;
  cached.resolve({review:null,lookback:null,previousDate:'2026-11-03'});await h.flush();
  assert.equal(published.length,count,'initial cache must not republish after a newer explicit operation');
});

test('a delayed candidates cache cannot erase a completed ranking', async t => {
  const store=require('./selectionReportStore.ts'),previous=store.getSelectionReport();
  store.setSelectionReport({asOfDate:'2026-11-04',strategies:[{id:'sample',name:'样例',stocks:[{code:'600001',name:'甲',signalStrength:70}]}]});
  t.after(()=>store.setSelectionReport(previous));const cached=deferredList();
  const {h,button}=asyncPanelHarness(t,'../ai-picks/AiPicksView.tsx','default',{live:false},
    {status:async()=>({configured:true}),cached:()=>cached.promise,rank:async()=>({items:[{code:'600001',score:60,rating:'关注'}]})});
  await h.flush();button(h.tree,'AI 打分').props.onClick();await h.flush();button(h.tree,'全部重新打分');
  cached.resolve({rank:null,summary:null});await h.flush();button(h.tree,'全部重新打分');
});

test('my-stocks initial cache cannot erase a fresh score', async t => {
  const cached=deferredList();
  const {h,props,button}=customBoardHarness(t,{customList:async()=>[{code:'600001',name:'甲'}],cachedCustom:()=>cached.promise,
    rankCustom:async()=>({items:[{code:'600001',name:'甲',score:60,rating:'关注'}]})});
  props.configured=true;await h.flush();button(h.tree,'AI 打分').props.onClick();await h.flush();button(h.tree,'全部重新打分');
  cached.resolve(null);await h.flush();button(h.tree,'全部重新打分');
});

test('my-stocks reload recovers scoring and an earlier framework result cannot publish', async t => {
  const first=deferredList(),second=deferredList();let calls=0;
  const {h,props,button}=customBoardHarness(t,{customList:async()=>[{code:'600001',name:'甲'}],cachedCustom:async()=>null,
    rankCustom:()=>++calls===1?first.promise:second.promise});
  t.after(()=>{first.resolve({items:[]});second.resolve({items:[]});});
  props.configured=true;await h.flush();button(h.tree,'AI 打分').props.onClick();await h.flush();props.reload++;h.render();await h.flush();
  assert.equal(button(h.tree,'AI 打分').props.disabled,false);
  button(h.tree,'AI 打分').props.onClick();await h.flush();first.reject(Error('obsolete-framework-result'));await h.flush();
  const {text}=require('../../../qa/research-hook-harness.cjs');
  assert.doesNotMatch(text(h.tree),/obsolete-framework-result/);assert.equal(button(h.tree,'读取日线并打分…').props.disabled,true);
  second.resolve({items:[]});await h.flush();assert.equal(button(h.tree,'AI 打分').props.disabled,false);
});

test('my-stocks does not notify its parent of a completed rank after unmount', async t => {
  const pending=deferredList();let changes=0;
  const {h,props,button}=customBoardHarness(t,{customList:async()=>[{code:'600001',name:'甲'}],rankCustom:()=>pending.promise});
  props.configured=true;props.onChanged=()=>{changes++;};await h.flush();button(h.tree,'AI 打分').props.onClick();await h.flush();
  h.dispose();pending.resolve({items:[]});await new Promise(resolve=>setImmediate(resolve));assert.equal(changes,0);
});

test('AI settings cannot replace an acknowledged profile save with an earlier list snapshot', async t => {
  const initial=deferredList();
  const saved={id:'new',name:'新模型',baseUrl:'https://example.com/v1',model:'demo',hasKey:true};
  const list={profiles:[saved],activeId:saved.id,max:8,saved};
  const {h,button,text}=asyncPanelHarness(t,'../settings/AiSettingsCard.tsx','AiSettingsCard',
    {hidden:false,draft:{},setDraft:()=>{},onSave:()=>{},saving:false,saveError:'',loadState:'ready'},
    {profiles:()=>initial.promise,saveProfile:async()=>list});
  button(h.tree,'新增模型配置').props.onClick();await h.flush();button(h.tree,'保存这套配置').props.onClick();await h.flush();
  assert.match(text(h.tree),/新模型/);initial.resolve({profiles:[],activeId:'',max:8});await h.flush();
  assert.match(text(h.tree),/新模型/);assert.doesNotMatch(text(h.tree),/还没有模型配置/);
});

test('starting a fresh AI summary preserves the independent cached ranking', async t => {
  const store=require('./selectionReportStore.ts'),previous=store.getSelectionReport();
  store.setSelectionReport({asOfDate:'2026-11-04',strategies:[{id:'sample',name:'样例',stocks:[{code:'600001',name:'甲',signalStrength:70}]}]});
  t.after(()=>store.setSelectionReport(previous));const cached=deferredList();
  const fresh={headline:'fresh-summary',model:'test',generatedAt:new Date().toISOString(),themes:[],focus:[],risks:[]};
  const {h,button,text}=asyncPanelHarness(t,'../ai-picks/AiPicksView.tsx','default',{live:false},
    {status:async()=>({configured:true}),cached:()=>cached.promise,summary:async()=>fresh});
  await h.flush();button(h.tree,'AI 总结').props.onClick();await h.flush();
  cached.resolve({rank:{items:[{code:'600001',score:60,rating:'关注'}]},summary:null});await h.flush();
  button(h.tree,'全部重新打分');assert.match(text(h.tree),/fresh-summary/);
});

test('starting a fresh AI ranking preserves the independent cached summary', async t => {
  const store=require('./selectionReportStore.ts'),previous=store.getSelectionReport();
  store.setSelectionReport({asOfDate:'2026-11-04',strategies:[{id:'sample',name:'样例',stocks:[{code:'600001',name:'甲',signalStrength:70}]}]});
  t.after(()=>store.setSelectionReport(previous));const cached=deferredList();
  const summary={headline:'saved-summary',model:'test',generatedAt:new Date().toISOString(),themes:[],focus:[],risks:[]};
  const {h,button,text}=asyncPanelHarness(t,'../ai-picks/AiPicksView.tsx','default',{live:false},
    {status:async()=>({configured:true}),cached:()=>cached.promise,rank:async()=>({items:[{code:'600001',score:60,rating:'关注'}]})});
  await h.flush();button(h.tree,'AI 打分').props.onClick();await h.flush();
  cached.resolve({rank:null,summary});await h.flush();button(h.tree,'全部重新打分');assert.match(text(h.tree),/saved-summary/);
});

test('a fresh market review preserves the independent saved lookback', async t => {
  const cached=deferredList();
  const {h,button,text}=asyncPanelHarness(t,'../ai-review/AiMarketReviewPanel.tsx','AiMarketReviewPanel',
    {asOfDate:'2026-11-04'},
    {status:async()=>({configured:true}),cachedMarketReview:()=>cached.promise,marketReview:async()=>null,lookback:async()=>null});
  await h.flush();button(h.tree,'AI 复盘').props.onClick();await h.flush();
  cached.resolve({review:null,previousDate:'2026-11-03',lookback:{previousDate:'2026-11-03',summary:'saved-lookback',
    model:'test',generatedAt:new Date().toISOString(),hitRatePct:null,judged:0,verdicts:[],lessons:[]}});await h.flush();
  assert.match(text(h.tree),/saved-lookback/);
});

test('testing a connection does not discard the initial saved profile list', async t => {
  const initial=deferredList();const saved={id:'existing',name:'已有模型配置',baseUrl:'https://example.com/v1',model:'demo',hasKey:true};
  const {h,button,text}=asyncPanelHarness(t,'../settings/AiSettingsCard.tsx','AiSettingsCard',
    {hidden:false,draft:{},setDraft:()=>{},onSave:()=>{},saving:false,saveError:'',loadState:'ready'},
    {profiles:()=>initial.promise,test:async()=>({ok:true,model:'demo',latency:1})});
  button(h.tree,'新增模型配置').props.onClick();await h.flush();button(h.tree,'测试连接').props.onClick();await h.flush();
  initial.resolve({profiles:[saved],activeId:saved.id,max:8});await h.flush();button(h.tree,'取消').props.onClick();await h.flush();
  assert.match(text(h.tree),/已有模型配置/);
});

test('a failed profile save leaves the pending initial list read available for recovery', async t => {
  const initial=deferredList();const saved={id:'existing',name:'已有模型配置',baseUrl:'https://example.com/v1',model:'demo',hasKey:true};
  const {h,button,text}=asyncPanelHarness(t,'../settings/AiSettingsCard.tsx','AiSettingsCard',
    {hidden:false,draft:{},setDraft:()=>{},onSave:()=>{},saving:false,saveError:'',loadState:'ready'},
    {profiles:()=>initial.promise,saveProfile:async()=>{throw Error('save failed');}});
  button(h.tree,'新增模型配置').props.onClick();await h.flush();button(h.tree,'保存这套配置').props.onClick();await h.flush();
  initial.resolve({profiles:[saved],activeId:saved.id,max:8});await h.flush();button(h.tree,'取消').props.onClick();await h.flush();
  assert.match(text(h.tree),/已有模型配置/);assert.match(text(h.tree),/save failed/);
});

test('sector interpretation restores its saved headline without rendering the metadata caption', async t => {
  const stored = { headline: '已保存的行业解读', asOfDate: '2026-11-10', model: 'fixture-model', cached: true,
    generatedAt: '2026-11-10T06:00:00Z', points: [], risks: [], watch: [] };
  const { h, text } = asyncPanelHarness(t, '../ai-review/AiInterpretPanel.tsx', 'AiInterpretPanel',
    { kind: 'sectors', getData: () => ({}) },
    { status: async () => ({ configured: true }), cachedInterpret: async () => stored, interpret: async () => assert.fail() });
  await h.flush();
  assert.match(text(h.tree), /已保存的行业解读/);
  assert.doesNotMatch(text(h.tree), /fixture-model|本机已保存|数据日/);
});
