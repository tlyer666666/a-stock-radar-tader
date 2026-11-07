"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const React = require("react");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const restoreTypeScript = registerTypeScript();
const { HoldingsView } = require("./CollectionViews.tsx");
const { NewsView } = require("../information/NewsView.tsx");
const { SettingsView } = require("../settings/SettingsView.tsx");
const { initialSettings } = require("../../domain/settings.ts");
const { createCollectionWriter } = require("../../collectionWriter.ts");
after(() => restoreTypeScript?.());

// Run actual component hooks and event handlers without a browser, disk storage,
// an application API, or production holdings. Scheduling remains under the test.
function mount(Component, initialProps) {
  const slots=[];
  let cursor=0, props=initialProps, dirty=true, tree;
  const effects=[];
  const same=(a,b)=>a&&b&&a.length===b.length&&a.every((value,index)=>Object.is(value,b[index]));
  const dispatcher={
    useState(initial) {
      const index=cursor++;
      if(!slots[index]) slots[index]={value:typeof initial==='function'?initial():initial};
      return [slots[index].value,update=>{const next=typeof update==='function'?update(slots[index].value):update;if(!Object.is(next,slots[index].value)){slots[index].value=next;dirty=true;}}];
    },
    useRef(initial) {const index=cursor++;return slots[index]??(slots[index]={current:initial});},
    useMemo(factory,deps) {const index=cursor++;if(!slots[index]||!same(slots[index].deps,deps))slots[index]={value:factory(),deps};return slots[index].value;},
    useCallback(callback,deps) {return this.useMemo(()=>callback,deps);},
    useEffect(effect,deps) {const index=cursor++;if(!slots[index]||!same(slots[index].deps,deps)){const previous=slots[index];slots[index]={deps,cleanup:previous?.cleanup};effects.push(()=>{slots[index].cleanup?.();slots[index].cleanup=effect();});}}
  };
  const render=()=>{
    cursor=0;dirty=false;
    const internals=React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const previous=internals.H;internals.H=dispatcher;
    try{tree=Component(props);}finally{internals.H=previous;}
  };
  const harness={
    get tree(){if(dirty)render();return tree;},
    setProps(next){props={...props,...next};dirty=true;},
    async flush(){for(let cycle=0;cycle<20;cycle++){if(dirty)render();while(effects.length)effects.shift()();await new Promise(resolve=>setImmediate(resolve));if(!dirty&&!effects.length)return;}throw Error('Component did not settle');},
    unmount(){for(const slot of slots)slot?.cleanup?.();}
  };
  return harness;
}
function nodes(value,result=[]) {
  if(Array.isArray(value)){value.forEach(item=>nodes(item,result));return result;}
  if(!value||typeof value!=='object')return result;
  if(value.type){result.push(value);nodes(value.props?.children,result);nodes(value.props?.actions,result);}
  return result;
}
function text(value) {
  if(Array.isArray(value))return value.map(text).join('');
  if(value===null||value===undefined||typeof value==='boolean')return '';
  if(typeof value!=='object')return String(value);
  return text(value.props?.children);
}
function find(harness,predicate){const found=nodes(harness.tree).find(predicate);assert.ok(found,'Expected component element was not rendered');return found;}
function button(harness,name){return find(harness,node=>node.type==='button'&&(node.props['aria-label']===name||text(node)===name));}
function input(harness,label){return find(harness,node=>node.type==='input'&&node.props['aria-label']===label);}
function change(harness,label,value){input(harness,label).props.onChange({target:{value}});}
function row(harness,name){return find(harness,node=>node.props?.className==='tr'&&text(node).includes(name));}
function fact(harness,label){return find(harness,node=>node.props?.label===label).props.value;}
const sample={code:'600001',name:'隔离样例甲',thscode:'600001.SH',shares:100,costPrice:10,note:'完整备注',createdAt:'2026-10-01T00:00:00Z',updatedAt:'2026-10-02T00:00:00Z',customField:'preserve'};
const second={...sample,code:'600002',name:'隔离样例乙',thscode:'600002.SH',costPrice:20};
function environment(api) {
  const oldWindow=global.window,oldDocument=global.document;
  global.window={stockApi:api,setInterval:()=>1,clearInterval(){},setTimeout:()=>1,clearTimeout(){}};
  global.document={hidden:false,addEventListener(){},removeEventListener(){}};
  return ()=>{if(oldWindow===undefined)delete global.window;else global.window=oldWindow;if(oldDocument===undefined)delete global.document;else global.document=oldDocument;};
}
async function holdings(run,initial=[sample,second]) {
  let state=structuredClone(initial),searchCalls=0,saveAttempts=0,failNext=false,pauseNext=false,releaseSave;
  const failures=new Set();
  const restore=environment({
    search:async code=>{searchCalls++;return [{code,name:'隔离样例甲',thscode:code+'.SH'}];},
    getQuoteSnapshot:async item=>{if(failures.has(item.code))throw Error('行情中断');return {quote:{latest:item.code==='600002'?22:12,preClose:item.code==='600002'?21:11,changePct:1},updatedAt:'2026-10-21T02:00:00Z'};}
  });
  let harness;
  const write=createCollectionWriter({read:()=>state,persist:async next=>{saveAttempts++;if(pauseNext){pauseNext=false;await new Promise(resolve=>{releaseSave=resolve;});}if(failNext){failNext=false;throw Error('隔离保存失败');}return next;},accept:next=>{state=next;harness.setProps({items:state});}});
  harness=mount(HoldingsView,{items:state,settings:initialSettings,live:false,onOpen(){},onSave:async update=>{try{await write(update);return true;}catch{return false;}}});
  try{await harness.flush();await run({harness,read:()=>structuredClone(state),searchCalls:()=>searchCalls,saveAttempts:()=>saveAttempts,failures,write,fail:()=>{failNext=true;},pause:()=>{pauseNext=true;},release:()=>releaseSave()});}
  finally{harness.unmount();restore();}
}

// Stripping punctuation, rounding, or accepting unsafe integers breaks this test.
test('holding quantity preserves invalid drafts and refuses to persist them',async()=>holdings(async fixture=>{
  const {harness}=fixture;
  change(harness,'证券代码','600001');change(harness,'成本价','10');
  for(const raw of ['1.5','-100','1e3','0','9007199254740992']){
    change(harness,'持仓数量',raw);
    assert.equal(input(harness,'持仓数量').props.value,raw);
    await find(harness,node=>node.type==='form').props.onSubmit({preventDefault(){}});
    assert.match(text(harness.tree),/整数/);
    assert.equal(input(harness,'持仓数量').props.value,raw);
    assert.equal(fixture.saveAttempts(),0);assert.equal(fixture.searchCalls(),0);
  }
  change(harness,'持仓数量','150');
  await find(harness,node=>node.type==='form').props.onSubmit({preventDefault(){}});
  await harness.flush();assert.equal(fixture.read()[0].shares,150);
},[]));

test('failed refresh labels the previous quote and excludes its valuation from current summaries',async()=>holdings(async({harness,failures})=>{
  assert.match(text(row(harness,'隔离样例甲')),/12\.00 元/);
  const successfulTime=text(nodes(row(harness,'隔离样例甲')).find(node=>node.type==='small'&&text(node).startsWith('报价更新 '))).slice('报价更新 '.length);
  assert.ok(successfulTime);
  failures.add('600001');await button(harness,'刷新行情').props.onClick();await harness.flush();
  const details=text(row(harness,'隔离样例甲'));
  assert.match(details,/刷新失败/);assert.match(details,/上次报价/);assert.ok(details.includes(successfulTime));assert.match(details,/参考/);
  assert.match(text(harness.tree),/不计入汇总/);
  assert.equal(fact(harness,'持仓市值'),'2,200');
  failures.clear();await button(harness,'刷新行情').props.onClick();await harness.flush();
  assert.doesNotMatch(text(row(harness,'隔离样例甲')),/刷新失败/);
  assert.equal(fact(harness,'持仓市值'),'3,400');
}));

for (const [label, changePct, missingFields] of [
  ['null', null, []], ['undefined', undefined, []], ['blank', '', []], ['explicitly missing zero', 0, ['changePct']]
]) test(`holdings show a neutral missing change percentage for ${label}`, async () => {
  const restore=environment({ getQuoteSnapshot:async()=>({quote:{latest:12,preClose:11,changePct,missingFields},updatedAt:'2026-10-21T02:00:00Z'}) });
  const harness=mount(HoldingsView,{items:[sample],settings:initialSettings,live:false,onOpen(){},onSave:async()=>true});
  try {
    await harness.flush();
    const details=row(harness,'隔离样例甲');
    assert.doesNotMatch(text(details),/\+0\.00%/);
    const missing=nodes(details).find(node=>node.type==='small'&&text(node)==='--');
    assert.ok(missing,'missing percentage is displayed as --');
    assert.doesNotMatch(missing.props.className||'',/\b(?:up|down)\b/);
    assert.equal(fact(harness,'持仓市值'),'1,200','valid price remains available');
  } finally { harness.unmount();restore(); }
});

test('holdings preserve a supplied zero change percentage',async()=>{
  const restore=environment({getQuoteSnapshot:async()=>({quote:{latest:12,preClose:12,changePct:0,missingFields:[]},updatedAt:'2026-10-21T02:00:00Z'})});
  const harness=mount(HoldingsView,{items:[sample],settings:initialSettings,live:false,onOpen(){},onSave:async()=>true});
  try{await harness.flush();assert.match(text(row(harness,'隔离样例甲')),/\+0\.00%/);}
  finally{harness.unmount();restore();}
});

test('removal Undo restores every holding field while merging concurrent changes',async()=>holdings(async({harness,read,write})=>{
  const original=read()[0];
  nodes(row(harness,'隔离样例甲')).find(node=>node.type==='button'&&text(node)==='移除').props.onClick();await harness.flush();
  assert.match(text(find(harness,node=>node.props?.role==='status')),/隔离样例甲/);
  await write(current=>current.map(item=>({...item,shares:300})));await harness.flush();
  await button(harness,'撤销移除').props.onClick();await harness.flush();
  assert.deepEqual(read().find(item=>item.code==='600001'),original);
  assert.equal(read().find(item=>item.code==='600002').shares,300);
}));

test('failed removal has no success and failed Undo stays retryable without duplicating readded holdings',async()=>holdings(async({harness,read,write,fail})=>{
  const remove=()=>nodes(row(harness,'隔离样例甲')).find(node=>node.type==='button'&&text(node)==='移除').props.onClick();
  fail();await remove();await harness.flush();
  assert.equal(read().length,2);assert.equal(nodes(harness.tree).filter(node=>node.type==='button'&&node.props['aria-label']==='撤销移除').length,0);
  await remove();await harness.flush();fail();await button(harness,'撤销移除').props.onClick();await harness.flush();
  assert.equal(read().length,1);assert.match(text(find(harness,node=>node.props?.role==='alert')),/撤销/);
  await write(current=>[...current,{...sample,shares:777,name:'重新加入的样例甲'}]);await harness.flush();
  await button(harness,'撤销移除').props.onClick();await harness.flush();
  assert.equal(read().length,2);assert.equal(read().find(item=>item.code==='600001').shares,777);
}));

test('removal success waits until persistence finishes',async()=>holdings(async({harness,read,pause,release})=>{
  pause();nodes(row(harness,'隔离样例甲')).find(node=>node.type==='button'&&text(node)==='移除').props.onClick();await harness.flush();
  assert.equal(read().length,2);assert.equal(nodes(harness.tree).filter(node=>node.props?.role==='status').length,0);
  release();await harness.flush();button(harness,'撤销移除');assert.equal(read().length,1);
}));

async function news(initial,run,props={}){
  let behavior=initial;
  const item={id:'fixture-news',title:'隔离样例资讯',type:'flash',direction:'positive',source:'隔离源',sourceLevel:'B',firstSeenAt:'2026-10-21T02:00:00Z',publishedAt:'2026-10-21 10:00:00',relatedStocks:[],relatedSectors:[]};
  const getFeed=async()=>{if(typeof behavior==='object')return structuredClone(behavior);if(behavior==='failure')throw Error('隔离网络失败');return {items:behavior==='empty'?[]:[item],sourceStatus:behavior==='stale'?[{id:'fast',name:'隔离源',ok:true,stale:true,fetchedAt:'2026-10-21T02:00:00Z'}]:[],updatedAt:'2026-10-21T02:00:00Z',refreshAfterSeconds:3600};};
  const restore=environment({getNewsFeed:getFeed,refreshNewsFeed:getFeed});
  const harness=mount(NewsView,{payload:null,watchlist:[],holdings:[],limitUps:[],settings:initialSettings,onContentTypeChange(){},onOpenStock(){},...props});
  try{await harness.flush();await run(harness,value=>{behavior=value;});}finally{harness.unmount();restore();}
}
test('initial news failure offers retry without claiming a filter has no matches',async()=>news('failure',async(harness,setBehavior)=>{
  assert.match(text(harness.tree),/资讯加载失败/);assert.doesNotMatch(text(harness.tree),/暂无匹配/);
  setBehavior('loaded');await button(harness,'重新加载资讯').props.onClick();await harness.flush();assert.match(text(harness.tree),/隔离样例资讯/);
}));
test('news distinguishes an empty feed, an empty filter, and retained content after refresh failure',async()=>news('empty',async(harness,setBehavior)=>{
  assert.match(text(harness.tree),/当前范围暂无资讯/);assert.doesNotMatch(text(harness.tree),/暂无匹配/);
  setBehavior('loaded');await button(harness,'立即刷新').props.onClick();await harness.flush();
  find(harness,node=>node.type==='input'&&node.props.placeholder==='搜索股票、板块、事件关键词').props.onChange({target:{value:'不存在关键词'}});
  assert.match(text(harness.tree),/当前筛选暂无匹配资讯/);
  find(harness,node=>node.type==='input'&&node.props.placeholder==='搜索股票、板块、事件关键词').props.onChange({target:{value:''}});
  setBehavior('failure');await button(harness,'立即刷新').props.onClick();await harness.flush();
  assert.match(text(harness.tree),/隔离样例资讯/);assert.match(text(find(harness,node=>node.props?.role==='alert')),/保留上次/);
}));
test('news warns when the backend returns cached content after a source failure',async()=>news('stale',async harness=>{
  assert.match(text(harness.tree),/隔离样例资讯/);
  assert.match(text(find(harness,node=>node.props?.role==='alert')),/缓存/);
}));
const announcementFailureFeed={items:[],sourceStatus:[
  {id:'fast',name:'财经快讯',ok:true,stale:false},
  {id:'cls',name:'财联社',ok:true,stale:false},
  {id:'announcement',name:'公司公告聚合',ok:false,stale:false,message:'公告连接失败'},
  {id:'ths',name:'同花顺公告',ok:null,stale:false,message:'未启用'}
],updatedAt:'2026-10-21T02:00:00Z',refreshAfterSeconds:3600};
test('announcement source failure offers retry even when unrelated flash sources succeed',async()=>news(announcementFailureFeed,async(harness,setBehavior)=>{
  assert.match(text(harness.tree),/公告加载失败/);
  assert.doesNotMatch(text(harness.tree),/当前范围暂无公告/);
  const failure=text(find(harness,node=>node.props?.role==='alert'));
  assert.match(failure,/公司公告聚合/);assert.doesNotMatch(failure,/同花顺公告/);
  setBehavior({items:[{id:'announcement-1',title:'隔离公告恢复',type:'announcement',direction:'neutral',source:'公告聚合',sourceLevel:'B',firstSeenAt:'2026-10-21T02:00:00Z',relatedStocks:[],relatedSectors:[]}],sourceStatus:[{id:'announcement',name:'公司公告聚合',ok:true,stale:false}],updatedAt:'2026-10-21T02:00:00Z'});
  await button(harness,'重新加载公告').props.onClick();await harness.flush();
  assert.match(text(harness.tree),/隔离公告恢复/);assert.doesNotMatch(text(harness.tree),/公告加载失败/);
},{contentType:'announcement'}));
test('a partial news source failure warns while preserving available items',async()=>news({...announcementFailureFeed,items:[{id:'flash-1',title:'仍可用的快讯',type:'flash',direction:'neutral',source:'财经快讯',sourceLevel:'B',firstSeenAt:'2026-10-21T02:00:00Z',relatedStocks:[],relatedSectors:[]}]},async harness=>{
  assert.match(text(harness.tree),/仍可用的快讯/);
  const warning=text(find(harness,node=>node.props?.role==='alert'));
  assert.match(warning,/公司公告聚合/);assert.match(warning,/失败/);assert.doesNotMatch(warning,/同花顺公告/);
}));
test('a disabled announcement source does not turn a successful empty result into a failure',async()=>news({...announcementFailureFeed,sourceStatus:[{id:'announcement',name:'公司公告聚合',ok:true,stale:false},{id:'ths',name:'同花顺公告',ok:null,stale:false,message:'未启用'}]},async harness=>{
  assert.match(text(harness.tree),/当前范围暂无公告/);
  assert.equal(nodes(harness.tree).filter(node=>node.props?.role==='alert').length,0);
},{contentType:'announcement'}));
test('the maximum selectable quote refresh interval survives saving unchanged',async()=>{
  const restore=environment({});let saved;let harness;
  harness=mount(SettingsView,{value:initialSettings,loadState:'ready',onSave:async patch=>{saved={...initialSettings,...patch};harness.setProps({value:saved});return saved;}});
  try{
    await harness.flush();
    const slider=find(harness,node=>node.type==='input'&&node.props.type==='range'&&node.props.min==='3');
    const chosen=Number(slider.props.max);slider.props.onChange({target:{value:String(chosen)}});
    const monitoring=find(harness,node=>node.props?.id==='settings-monitoring');
    await nodes(monitoring).find(node=>node.type==='button'&&text(node)==='保存设置').props.onClick();await harness.flush();
    assert.equal(saved.quoteRefreshSeconds,chosen);
    assert.equal(find(harness,node=>node.type==='input'&&node.props.type==='range'&&node.props.min==='3').props.value,chosen);
  }finally{harness.unmount();restore();}
});
