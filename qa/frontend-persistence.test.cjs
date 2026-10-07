const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const {createPreview,openView}=require('./frontend-v150.cjs');
let fixture;
before(async()=>{fixture=await createPreview();});
after(async()=>{await fixture?.close();});
async function page(){const p=await fixture.browser.newPage({viewport:{width:1480,height:960}});p.setDefaultTimeout(10000);return p;}
async function ready(p){await p.goto(fixture.url);await p.locator('.workspace-navigation').waitFor();}
async function paperStorageFixture(p, code) {
 await p.addInitScript(code => {
  const key='a-stock-radar-v054-paper-sim-v1';
  if(!localStorage.getItem('paper-fault-seeded')){
   localStorage.setItem('paper-fault-seeded','1');
   localStorage.setItem(key,JSON.stringify({initialCapital:100000,cash:99000,openPositions:[{id:'p',code,name:'合成纸面仓',shares:100,entryPrice:10,latestPrice:10,stopPrice:8,takePrice:20,holdingBars:0,highWaterMark:10,openedAt:new Date().toISOString()}],closedPositions:[],totalTradeCount:1}));
  }
  window.failPaperSave=true;window.paperWrites=0;const set=Storage.prototype.setItem;
  Storage.prototype.setItem=function(k,v){if(k===key){window.paperWrites++;if(window.failPaperSave)throw new DOMException('synthetic quota','QuotaExceededError');}return set.call(this,k,v);};
  let api;Object.defineProperty(window,'stockApi',{get:()=>api,set(value){api=value;const analyze=value.analyze.bind(value);value.analyze=async(...args)=>{const result=await analyze(...args);return {...result,quote:{...result.quote,latest:window.syntheticPrice||12}};};}});
 },code);
 await ready(p);
}
async function analyzePaperFixture(p) {
 await p.locator('#global-security-search').fill('茅台');await p.locator('#global-security-suggestions button').first().click();await p.locator('.paper-sim-panel').waitFor();
}
test('failed manual paper close keeps the ledger unchanged; retry commits once and survives reload',async()=>{
 const p=await page();try{
  await paperStorageFixture(p,'600001');await analyzePaperFixture(p);
  const key='a-stock-radar-v054-paper-sim-v1',before=await p.evaluate(key=>localStorage.getItem(key),key);
  await p.locator('.paper-position-table').getByRole('button',{name:'平仓',exact:true}).click();
  await p.getByRole('alert').filter({hasText:'本次操作未生效'}).waitFor();
  assert.equal(await p.locator('.paper-position-table').getByRole('button',{name:'平仓',exact:true}).count(),1);
  assert.equal(await p.evaluate(key=>localStorage.getItem(key),key),before);
  assert.equal(await p.getByText(/已全部平仓/).count(),0);
  await p.evaluate(()=>{window.failPaperSave=false;window.paperWrites=0;});
  await p.locator('.paper-position-table').getByRole('button',{name:'平仓',exact:true}).click();
  await p.waitForFunction(key=>JSON.parse(localStorage.getItem(key)).openPositions.length===0,key);
  assert.equal(await p.evaluate(()=>window.paperWrites),1,'manual commit must not be repeated by the effect');
  const saved=await p.evaluate(key=>JSON.parse(localStorage.getItem(key)),key);assert.equal(saved.closedPositions.length,1);
  await p.reload();await p.locator('.workspace-navigation').waitFor();await analyzePaperFixture(p);
  assert.equal(await p.locator('.paper-position-table').getByRole('button',{name:'平仓',exact:true}).count(),0);
  assert.equal(await p.evaluate(key=>JSON.parse(localStorage.getItem(key)).cash,key),saved.cash);
 }finally{await p.close();}
});
test('automatic paper persistence failure stays visible across navigation and retries the latest quote',async()=>{
 const p=await page();try{
  await paperStorageFixture(p,'600519');await analyzePaperFixture(p);
  await p.getByRole('alert').filter({hasText:'未保存的行情更新'}).waitFor();
  await openView(p,'settings','数据源设置');assert.equal(await p.getByRole('alert').filter({hasText:'未保存的行情更新'}).count(),1);
  await p.evaluate(()=>{window.syntheticPrice=13;window.paperWrites=0;});await analyzePaperFixture(p);
  await p.waitForFunction(()=>window.paperWrites>0);
  await p.evaluate(()=>window.failPaperSave=false);await p.getByRole('button',{name:'重试保存纸面账户',exact:true}).click();
  await p.waitForFunction(()=>JSON.parse(localStorage.getItem('a-stock-radar-v054-paper-sim-v1')).openPositions[0].latestPrice===13);
  await p.getByRole('alert').filter({hasText:'未保存的行情更新'}).waitFor({state:'hidden'});
  assert.equal(await p.getByRole('alert').filter({hasText:'未保存的行情更新'}).count(),0);
  const saved=await p.evaluate(()=>JSON.parse(localStorage.getItem('a-stock-radar-v054-paper-sim-v1')));
  assert.equal(saved.openPositions[0].highWaterMark,13);assert.equal(saved.openPositions.length,1);
 }finally{await p.close();}
});
for (const primary of ['[null,{"code":"bad"}]', '{', '[]']) test('portfolio basket hydration preserves backup and later intentional clear: '+primary, async()=>{
 const p=await page(),key='a-stock-radar-portfolio-backtest-basket-v1';try{
  await p.addInitScript(({key,primary})=>{
   const backup=JSON.stringify([{code:'600001',name:'合成备份股票',secid:'1.600001',assetType:'stock'}]);
   localStorage.setItem(key,primary);localStorage.setItem(key+':last-good',backup);window.basketBackup=backup;
  },{key,primary});
  await ready(p);await openView(p,'backtest','回测中心');await p.getByRole('button',{name:'多股组合回测',exact:true}).click();
  await p.locator('.portfolio-backtest-view').waitFor();
  await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
  assert.equal(await p.evaluate(key=>localStorage.getItem(key),key),primary);
  assert.equal(await p.evaluate(key=>localStorage.getItem(key+':last-good')===window.basketBackup,key),true);
  assert.equal(await p.getByText('合成备份股票',{exact:true}).count(),primary==='[]'?0:1);
  if(primary!=='[]'){
   await p.locator('.pbt-basket-actions').getByRole('button',{name:'清空',exact:true}).click();
   await p.waitForFunction(key=>localStorage.getItem(key)==='[]',key);
   assert.equal(await p.evaluate(key=>localStorage.getItem(key+':last-good')===window.basketBackup,key),true);
  }
 }finally{await p.close();}
});
test('startup local actions cannot persist defaults over settings still loading',async()=>{
const p=await page();try{
await p.addInitScript(()=>{let api;Object.defineProperty(window,'stockApi',{get:()=>api,set(value){api=value;const original=value.getSettings.bind(value);value.getSettings=async()=>{const saved=await original();return new Promise(resolve=>{window.finishStartup=()=>resolve({...saved,refreshToken:'SYNTHETIC_EXISTING',quoteRefreshSeconds:17});});};value.saveSettings=async next=>{window.written=next;return next;};}});});
await ready(p);await p.waitForFunction(()=>window.finishStartup);await p.getByRole('button',{name:'白天',exact:true}).click();
await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
assert.equal(await p.evaluate(()=>window.written),undefined);
await p.evaluate(()=>window.finishStartup());await openView(p,'settings','数据源设置');
await p.waitForFunction(()=>document.querySelector('input[type=password]')?.value==='SYNTHETIC_EXISTING');
await p.getByRole('button',{name:'白天',exact:true}).click();await p.waitForFunction(()=>window.written);
assert.equal(await p.evaluate(()=>window.written.refreshToken),'SYNTHETIC_EXISTING');assert.equal(await p.evaluate(()=>window.written.quoteRefreshSeconds),17);
}finally{await p.close();}});
test('settings old acknowledgement preserves new draft; failed draft never changes committed settings',async()=>{
const p=await page();try{await ready(p);await openView(p,'settings','数据源设置');const input=p.locator('input[type=password]').first();
await input.fill('SYNTHETIC_FIRST');await p.evaluate(()=>{window.stockApi.saveSettings=next=>new Promise(resolve=>{window.finishSave=()=>resolve(next);});});
await p.getByRole('button',{name:'保存设置',exact:true}).first().click();await p.waitForFunction(()=>window.finishSave);await input.fill('SYNTHETIC_SECOND');await p.evaluate(()=>window.finishSave());
await p.getByRole('button',{name:'保存设置',exact:true}).first().waitFor();assert.equal(await input.inputValue(),'SYNTHETIC_SECOND');
await p.evaluate(()=>{window.stockApi.saveSettings=async()=>{throw Error('SYNTHETIC_DISK_FAILURE');};});
await input.fill('SYNTHETIC_FAILED');await p.getByRole('button',{name:'保存设置',exact:true}).first().click();await p.getByRole('alert').first().waitFor();
assert.equal(await input.inputValue(),'SYNTHETIC_FAILED');await openView(p,'holdings','持仓股');await openView(p,'settings','数据源设置');assert.equal(await input.inputValue(),'SYNTHETIC_FIRST');
}finally{await p.close();}});
test('holding completion does not clear the next edited stock',async()=>{
const p=await page();try{await ready(p);await openView(p,'holdings','持仓股');await p.locator('.holdings-row-actions').first().getByRole('button',{name:'编辑',exact:true}).click();
await p.evaluate(()=>{const original=window.stockApi.search.bind(window.stockApi);window.stockApi.search=query=>new Promise(resolve=>{window.finishSearch=async()=>resolve(await original(query));});});
await p.getByRole('button',{name:'保存持仓',exact:true}).click();await p.waitForFunction(()=>window.finishSearch);await p.locator('.holdings-row-actions').nth(1).getByRole('button',{name:'编辑',exact:true}).click();const code=await p.getByLabel('证券代码',{exact:true}).inputValue();
await p.evaluate(()=>window.finishSearch());await p.waitForFunction(()=>!document.querySelector('.holdings-entry-form button').disabled);assert.equal(await p.getByLabel('证券代码',{exact:true}).inputValue(),code);
}finally{await p.close();}});
for(const mode of ['missing-group','optimized-superset','optimized-wrong-threshold','duplicate-group','two-votes'])test('portfolio requires all selected votes: '+mode,async()=>{
const p=await page();try{await ready(p);await p.evaluate(mode=>{
window.stockApi.getStrategyDefinitions=async()=>[{id:'mock-a',name:'Mock A'},{id:'mock-b',name:'Mock B'}];
const stock={code:'600001',name:'Synthetic selection',secid:'1.600001',assetType:'stock'};
const groups=[{id:'mock-a',stocks:[stock]},{id:'mock-b',stocks:mode==='two-votes'?[stock]:[]}];
const response=mode==='duplicate-group'?{strategies:[groups[0],groups[0],groups[1]]}:mode==='missing-group'?{strategies:groups.slice(0,1)}:{strategies:groups,optimizedPortfolio:{publicationAccepted:true,minimumVotes:mode==='optimized-wrong-threshold'?1:2,selectedStrategies:[{id:'mock-a'},{id:'mock-b'},...(mode==='optimized-superset'?[{id:'mock-c'}]:[])],stocks:[stock]}};
window.stockApi.scanStrategySignals=()=>new Promise(resolve=>{window.finishPortfolio=()=>resolve(response);});
},mode);
await openView(p,'backtest','回测中心');await p.getByRole('button',{name:'多股组合回测',exact:true}).click();await p.locator('.pbt-strategy-grid button').filter({hasText:'Mock B'}).click();await p.locator('.pbt-vote-setting input').fill('2');
await p.getByRole('button',{name:'按所选策略生成股票池',exact:true}).click();await p.waitForFunction(()=>window.finishPortfolio);assert.equal(await p.getByRole('button',{name:'正在复核策略股票池',exact:true}).isDisabled(),true);
await p.evaluate(()=>window.finishPortfolio());await p.getByRole('button',{name:'按所选策略生成股票池',exact:true}).waitFor();
assert.equal(await p.getByText('Synthetic selection',{exact:true}).count(),mode==='two-votes'?1:0);
if(mode!=='two-votes') assert.ok(await p.locator('.pbt-inline-state.warning').count()>0);
}finally{await p.close();}});

test('failed startup settings read blocks all persistence',async()=>{
const p=await page();try{
await p.addInitScript(()=>{let api;Object.defineProperty(window,'stockApi',{get:()=>api,set(value){api=value;value.getSettings=async()=>{throw Error('synthetic read failure');};value.saveSettings=async next=>{window.written=next;return next;};}});});
await ready(p);await openView(p,'settings','数据源设置');await p.getByText(/本地设置读取失败/).waitFor();
assert.equal(await p.getByRole('button',{name:'保存设置',exact:true}).first().isDisabled(),true);
await p.getByRole('button',{name:'白天',exact:true}).click();await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));assert.equal(await p.evaluate(()=>window.written),undefined);
}finally{await p.close();}});

test('slow holdings read does not block settings hydration and external theme preserves dirty fields',async()=>{
const p=await page();try{
await p.addInitScript(()=>{let api;Object.defineProperty(window,'stockApi',{get:()=>api,set(value){api=value;const get=value.getSettings.bind(value);value.getSettings=async()=>({...await get(),refreshToken:'SYNTHETIC_LOADED'});value.getHoldings=()=>new Promise(()=>{});}});});
await ready(p);await openView(p,'settings','数据源设置');const input=p.locator('input[type=password]').first();await p.waitForFunction(()=>document.querySelector('input[type=password]')?.value==='SYNTHETIC_LOADED');
assert.equal(await p.getByRole('button',{name:'保存设置',exact:true}).first().isDisabled(),false);
await input.fill('SYNTHETIC_DIRTY');await p.getByRole('button',{name:'白天',exact:true}).click();await p.waitForFunction(()=>document.documentElement.dataset.theme==='light');assert.equal(await input.inputValue(),'SYNTHETIC_DIRTY');
}finally{await p.close();}});

test('holding completion preserves newer edits of the same stock',async()=>{
const p=await page();try{await ready(p);await openView(p,'holdings','持仓股');await p.locator('.holdings-row-actions').first().getByRole('button',{name:'编辑',exact:true}).click();
await p.evaluate(()=>{const original=window.stockApi.search.bind(window.stockApi);window.stockApi.search=query=>new Promise(resolve=>{window.finishSearch=async()=>resolve(await original(query));});});
await p.getByRole('button',{name:'保存持仓',exact:true}).click();await p.waitForFunction(()=>window.finishSearch);await p.getByLabel('持仓备注',{exact:true}).fill('newer draft');
await p.evaluate(()=>window.finishSearch());await p.waitForFunction(()=>!document.querySelector('.holdings-entry-form button').disabled);assert.equal(await p.getByLabel('持仓备注',{exact:true}).inputValue(),'newer draft');
}finally{await p.close();}});

test('successful normalized settings replace the submitted draft when no newer edit exists',async()=>{
const p=await page();try{await ready(p);await openView(p,'settings','数据源设置');await p.getByRole('button',{name:'监控与提醒',exact:true}).click();const refresh=p.locator('#settings-monitoring input[type=range]').first();await refresh.fill('30');
await p.getByRole('button',{name:'保存设置',exact:true}).click();await p.getByText('设置已保存',{exact:true}).waitFor();assert.equal(await refresh.inputValue(),'20');
}finally{await p.close();}});

test('a queued form save preserves a pending theme change and explicitly clears dirty fields',async()=>{
const p=await page();try{await ready(p);await openView(p,'settings','数据源设置');
await p.evaluate(()=>{window.settingWrites=[];window.pendingSettingWrites=[];window.stockApi.saveSettings=next=>new Promise(resolve=>{window.settingWrites.push(next);window.pendingSettingWrites.push(()=>resolve(next));});});
await p.getByRole('button',{name:'白天',exact:true}).click();await p.waitForFunction(()=>window.settingWrites.length===1);
const token=p.locator('input[type=password]').first();await token.fill('SYNTHETIC_DRAFT');await p.getByRole('button',{name:'保存设置',exact:true}).first().click();
await p.evaluate(()=>window.pendingSettingWrites.shift()());await p.waitForFunction(()=>window.settingWrites.length===2);
assert.equal(await p.evaluate(()=>window.settingWrites[1].theme),'light');assert.equal(await p.evaluate(()=>window.settingWrites[1].refreshToken),'SYNTHETIC_DRAFT');
await p.evaluate(()=>window.pendingSettingWrites.shift()());await p.getByRole('button',{name:'保存设置',exact:true}).first().waitFor();
await token.fill('');await p.getByRole('button',{name:'保存设置',exact:true}).first().click();await p.waitForFunction(()=>window.settingWrites.length===3);
assert.equal(await p.evaluate(()=>window.settingWrites[2].refreshToken),'');assert.equal(await p.evaluate(()=>window.settingWrites[2].theme),'light');
await p.evaluate(()=>window.pendingSettingWrites.shift()());
}finally{await p.close();}});

// Five-round audit regressions exercise the real renderer against delayed APIs.
test('global search waits for composition and ignores IME Enter',async()=>{
const p=await page();try{await ready(p);
await p.evaluate(()=>{window.searchCalls=[];window.analysisCalls=[];window.stockApi.search=async q=>{window.searchCalls.push(q);return [{code:'600001',name:'合成候选',secid:'1.600001'}];};window.stockApi.analyze=async s=>{window.analysisCalls.push(s);throw Error('synthetic');};});
const input=p.locator('#global-security-search');await input.dispatchEvent('compositionstart');await input.fill('zhong');
await p.waitForTimeout(300);assert.deepEqual(await p.evaluate(()=>window.searchCalls),[]);
await input.dispatchEvent('keydown',{key:'Enter',keyCode:229,isComposing:true});assert.deepEqual(await p.evaluate(()=>window.analysisCalls),[]);
await input.fill('中');await input.dispatchEvent('compositionend');await p.locator('#global-security-suggestions button').first().waitFor();
assert.deepEqual(await p.evaluate(()=>window.searchCalls),['中']);
}finally{await p.close();}});
test('analysis completion preserves the next search edit',async()=>{
const p=await page();try{await ready(p);
await p.evaluate(()=>{const analyze=window.stockApi.analyze.bind(window.stockApi);window.stockApi.analyze=async stock=>{const value=await analyze(stock);return new Promise(resolve=>window.finishAnalysis=()=>resolve(value));};window.stockApi.search=async q=>[{code:q==='甲'?'600519':'000001',name:q==='甲'?'合成甲':'合成乙',secid:q==='甲'?'1.600519':'0.000001'}];});
const input=p.locator('#global-security-search');await input.fill('甲');await p.locator('#global-security-suggestions button').first().click();await p.waitForFunction(()=>window.finishAnalysis);
await input.fill('乙');await p.locator('#global-security-suggestions button').first().waitFor();await p.evaluate(()=>window.finishAnalysis());
await p.waitForFunction(()=>!document.querySelector('.analysis-workspace .loading'));
await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
assert.equal(await input.inputValue(),'乙');assert.equal(await p.locator('#global-security-suggestions button').count(),1);
}finally{await p.close();}});
test('local watchlist and version hydrate without waiting for holdings',async()=>{
const p=await page();try{await p.addInitScript(()=>{let api;Object.defineProperty(window,'stockApi',{get:()=>api,set(value){api=value;value.getHoldings=()=>new Promise(()=>{});}});});
await ready(p);await openView(p,'favorites','自选板块');
await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
assert.equal(await p.locator('.favorites-empty').count(),0);
}finally{await p.close();}});
for(const mode of ['all-bad','mixed','empty'])test('compare selection recovery preserves usable primary priority: '+mode,async()=>{
const p=await page();try{await p.addInitScript(mode=>{const key='a-stock-radar:compare-selection';const bad={code:'600001',name:{bad:'object'},secid:'1.600001'};const good={code:'600002',name:'有效主档',secid:'1.600002'};const rows=mode==='all-bad'?[bad]:mode==='mixed'?[good,bad]:[];window.originalCompare=JSON.stringify(rows);localStorage.setItem(key,window.originalCompare);localStorage.setItem(key+':last-good',JSON.stringify([{code:'600003',name:'有效备份',secid:'1.600003'}]));},mode);
await ready(p);await p.getByRole('button',{name:'多股同列',exact:true}).first().click();
await p.locator('.compare-selected-chips, .app-crash-fallback').waitFor();
await p.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
assert.equal(await p.locator('.app-crash-fallback').count(),0);
assert.equal(await p.locator('.compare-selected-chips button').count(),mode==='empty'?0:1);
if(mode!=='empty')assert.match(await p.locator('.compare-selected-chips').innerText(),mode==='mixed'?/有效主档/:/有效备份/);
assert.equal(await p.evaluate(()=>localStorage.getItem('a-stock-radar:compare-selection')===window.originalCompare),true,'restoring must not overwrite stored evidence');
}finally{await p.close();}});

for (const target of ['compare','portfolio']) test('search candidates belong to current input and wait for IME: '+target,async()=>{
const p=await page();try{await ready(p);await p.evaluate(()=>{window.calls=[];window.stockApi.search=q=>{window.calls.push(q);return q==='甲甲'?Promise.resolve([{code:'600001',name:'旧查询股票',secid:'1.600001',assetType:'stock'}]):new Promise(resolve=>window.finishNewSearch=()=>resolve([{code:'600002',name:'新查询股票',secid:'1.600002',assetType:'stock'}]));};});
if(target==='compare')await p.getByRole('button',{name:'多股同列',exact:true}).first().click();else{await openView(p,'backtest','回测中心');await p.getByRole('button',{name:'多股组合回测',exact:true}).click();}
const input=target==='compare'?p.getByLabel('搜索对比股票',{exact:true}):p.getByPlaceholder('输入股票名称或6位代码添加');const choices=p.locator(target==='compare'?'.compare-candidate-list':'.pbt-stock-suggestions');
await input.fill('甲甲');await choices.getByText('旧查询股票',{exact:true}).waitFor();await input.fill('乙乙');await p.waitForFunction(()=>window.finishNewSearch);assert.equal(await choices.getByText('旧查询股票',{exact:true}).count(),0);
await input.dispatchEvent('compositionstart');await input.fill('zhong');await p.evaluate(()=>window.calls=[]);await p.waitForTimeout(300);assert.deepEqual(await p.evaluate(()=>window.calls),[]);
await p.evaluate(()=>window.finishNewSearch());await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));assert.equal(await choices.getByText('新查询股票',{exact:true}).count(),0);
await input.fill('中中');await input.dispatchEvent('compositionend');await p.waitForFunction(()=>window.calls.includes('中中'));assert.deepEqual(await p.evaluate(()=>window.calls),['中中']);await p.evaluate(()=>window.finishNewSearch());await choices.getByText('新查询股票',{exact:true}).waitFor();
}finally{await p.close();}});

test('startup research recovery never rewrites a corrupt primary or a good backup',async()=>{
const p=await page();try{await p.addInitScript(()=>{
const date='2026-10-01T02:00:00Z';window.recoveryRows=[
['a-stock-radar-v054-execution-decision-log-v1',[{broken:true}],[{id:'saved-log',createdAt:date,source:'BACKTEST_CURRENT',result:'BLOCKED',level:'block',securityCode:'600001',securityName:'恢复日志',summary:'有效旧记录',score:20,reasons:[]}]],
['a-stock-radar-v054-backtest-history-v1',[{broken:true}],[{id:'saved-backtest',createdAt:date,securityCode:'600001',securityName:'恢复回测',draft:{securityCode:'600001'},rawResult:{security:{code:'600001',name:'恢复回测'},metrics:{accepted:false}}}]],
['a-stock-radar-v054-paper-sim-v1',{broken:true},{initialCapital:100000,cash:77700,openPositions:[],closedPositions:[],lastOpenAt:'',dailyRealizedPnl:0,lastTradeDate:'2026-10-01',totalTradeCount:12}]];
for(const [key,primary,backup] of window.recoveryRows){localStorage.setItem(key,JSON.stringify(primary));localStorage.setItem(key+':last-good',JSON.stringify(backup));}
window.recoveryWrites=[];const set=Storage.prototype.setItem;Storage.prototype.setItem=function(key,value){if(window.recoveryRows.some(r=>key.startsWith(r[0])))window.recoveryWrites.push(key);return set.call(this,key,value);};
});await ready(p);await p.getByRole('button',{name:'白天',exact:true}).click();await p.waitForFunction(()=>document.documentElement.dataset.theme==='light');await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
assert.deepEqual(await p.evaluate(()=>window.recoveryWrites),[]);assert.equal(await p.evaluate(()=>window.recoveryRows.every(([key,primary,backup])=>localStorage.getItem(key)===JSON.stringify(primary)&&localStorage.getItem(key+':last-good')===JSON.stringify(backup))),true);
}finally{await p.close();}});
