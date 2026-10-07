'use strict';
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
let server, browser, url;
before(async () => {
  const { createServer } = await import('vite');
  const marketSnapshot = require('../electron/review-service.cjs').buildProfessionalReviewSnapshot({generatedAt:'2026-10-01T08:00:00Z'});
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import Tester from '/src/SignalStockTester.tsx'; import Review from '/src/ProfessionalReview.tsx';
    window.requests=[];
    window.stockApi={search:q=>{window.requests.push(q); return Promise.resolve([{code:'600000',name:'浦发银行',secid:'1.600000',assetType:'stock'}]);},getProfessionalReview:()=>new Promise(()=>{})};
    const review=new URLSearchParams(location.search).has('review');
    if(review) localStorage.setItem('a-stock-radar-professional-review-v1',JSON.stringify([null,{id:'bad',title:{nested:'bad'},type:'stock'}, {id:'ok',type:'stock',title:'合成有效记录',date:'2026-10-01',score:50,verdict:'合成条件',note:'',createdAt:'2026-10-01T02:00:00Z',snapshot:{security:{code:'600000',name:'浦发银行'}}}]));
    const root=createRoot(document.getElementById('root')); window.unmountFixture=()=>root.unmount();
    if(new URLSearchParams(location.search).get('review')==='backup') {
      localStorage.setItem('a-stock-radar-professional-review-v1:last-good',JSON.stringify(JSON.parse(localStorage.getItem('a-stock-radar-professional-review-v1')).filter(row=>row?.id==='ok')));
      localStorage.setItem('a-stock-radar-professional-review-v1','[null]');
    }
    if(new URLSearchParams(location.search).get('review')==='market') {
      const snapshot=${JSON.stringify(marketSnapshot)};
      const good={id:'market-good',type:'market',title:'合成市场备份',date:'2026-10-01',score:snapshot.score,verdict:'合成条件',note:'',createdAt:'2026-10-01T08:00:00Z',snapshot};
      const bad=structuredClone(good);bad.id='market-bad';bad.title='损坏市场主档';bad.snapshot.scenarios[0].conditions=null;
      window.originalMarket=JSON.stringify([bad]);localStorage.setItem('a-stock-radar-professional-review-v1',window.originalMarket);
      localStorage.setItem('a-stock-radar-professional-review-v1:last-good',JSON.stringify([good]));
    }
    if(new URLSearchParams(location.search).get('review')==='mixed-backup') {
      const valid=JSON.parse(localStorage.getItem('a-stock-radar-professional-review-v1')).find(row=>row?.id==='ok');
      localStorage.setItem('a-stock-radar-professional-review-v1:last-good',JSON.stringify([{...valid,id:'backup-complete',title:'合成完整备份'}]));
    }
    root.render(review?React.createElement(Review):React.createElement(Tester,{strategy:{id:'synthetic',name:'合成策略'},onBacktest:r=>{window.selectedRequest=r}}));
  </script></body></html>`;
  server = await createServer({plugins:[{name:'signal-polish-fixture',configureServer(vite){vite.middlewares.use(async(request,response,next)=>{if(!request.url.startsWith('/__signal_polish__'))return next();try{response.setHeader('Content-Type','text/html');response.end(await vite.transformIndexHtml(request.url,html));}catch(error){next(error);}});}}],server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'});
  await server.listen(); url=`http://127.0.0.1:${server.httpServer.address().port}/__signal_polish__`;
  browser=await require('playwright-core').chromium.launch({executablePath:process.env.QA_CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
});
after(async()=>{await browser?.close();await server?.close();});
async function inPage(run,suffix='') {const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(3000);try{await page.goto(url+suffix);await run(page);assert.deepEqual(errors,[]);}finally{await page.close();}}

test('Chinese composition does not issue partial searches; confirmed text searches once',async()=>inPage(async page=>{
  const input=page.getByRole('combobox');await input.focus();await input.dispatchEvent('compositionstart');await input.fill('浦');
  await page.waitForTimeout(350);assert.deepEqual(await page.evaluate(()=>window.requests),[]);
  await input.fill('浦发银行');await input.dispatchEvent('compositionend');await page.getByRole('option').waitFor();
  assert.deepEqual(await page.evaluate(()=>window.requests),['浦发银行']);
}));
test('IME confirmation Enter cannot select a previously visible search choice',async()=>inPage(async page=>{
  const input=page.getByRole('combobox');await input.fill('浦发');await page.getByRole('option').waitFor();
  await input.dispatchEvent('compositionstart');await input.dispatchEvent('keydown',{key:'Enter',code:'Enter',isComposing:true});
  assert.equal(await input.inputValue(),'浦发');assert.equal(await page.getByRole('button',{name:'测试这只股票'}).isDisabled(),true);
}));
test('synchronous bridge failure displays an error and a later search can recover',async()=>inPage(async page=>{
  await page.evaluate(()=>{window.stockApi.search=()=>{throw Error('合成桥接失败')};});await page.getByRole('combobox').fill('浦发');
  await page.getByRole('status').filter({hasText:'合成桥接失败'}).waitFor();
  await page.evaluate(()=>{window.stockApi.search=q=>{window.requests.push(q);return Promise.resolve([{code:'600000',name:'浦发银行',secid:'1.600000'}]);};});
  await page.getByRole('combobox').fill('浦发银行');await page.getByRole('option').click();await page.getByRole('button',{name:'测试这只股票'}).click();
  assert.equal(await page.evaluate(()=>window.selectedRequest.security.code),'600000');
}));
test('corrupt archive rows cannot crash the archive tab and valid records remain visible',async()=>inPage(async page=>{
  await page.getByRole('tab',{name:/复盘档案/}).click();await page.getByText('合成有效记录',{exact:true}).waitFor();
  assert.equal(await page.locator('.review-archive-list > button').count(),1);
},'?review=1'));

test('a slow previous query cannot replace the current choice after a newer query completes',async()=>inPage(async page=>{
  await page.evaluate(()=>{window.stockApi.search=q=>q==='慢查询'?new Promise(resolve=>{window.finishOld=()=>resolve([{code:'600001',name:'旧结果',secid:'1.600001'}]);}):Promise.resolve([{code:'600000',name:'新结果',secid:'1.600000'}]);});
  const input=page.getByRole('combobox');await input.fill('慢查询');await page.waitForFunction(()=>window.finishOld);await input.fill('新查询');
  await page.getByRole('option').filter({hasText:'新结果'}).waitFor();await page.evaluate(()=>window.finishOld());
  assert.equal(await page.getByRole('option').locator('b').innerText(),'新结果');
  assert.equal(await page.getByRole('option').locator('span').innerText(),'600000');
}));
test('unmount invalidates a late failure without uncaught rejections or further search work',async()=>inPage(async page=>{
  await page.evaluate(()=>{window.stockApi.search=()=>new Promise((_resolve,reject)=>{window.finishOld=()=>reject(Error('late'));});});
  await page.getByRole('combobox').fill('慢查询');await page.waitForFunction(()=>window.finishOld);await page.evaluate(()=>window.unmountFixture());await page.evaluate(()=>window.finishOld());
  assert.equal(await page.locator('#root').innerText(),'');
}));


test('an archive with no usable primary rows recovers its last-good document without overwriting the primary',async()=>inPage(async page=>{
  await page.getByRole('tab',{name:/复盘档案/}).click();await page.getByText('合成有效记录',{exact:true}).waitFor();
  assert.equal(await page.locator('.review-archive-list > button').count(),1);
  assert.equal(await page.evaluate(()=>localStorage.getItem('a-stock-radar-professional-review-v1')),'[null]');
},'?review=backup'));


test('damaged market snapshots recover a complete archived market view without changing the original',async()=>inPage(async page=>{
  await page.getByRole('tab',{name:/复盘档案/}).click();await page.getByText('合成市场备份',{exact:true}).click();
  await page.getByRole('heading',{name:'专业复盘',exact:true}).waitFor();
  assert.equal(await page.locator('.review-regime-card').count(),1);
  assert.equal(await page.evaluate(()=>localStorage.getItem('a-stock-radar-professional-review-v1')===window.originalMarket),true);
},'?review=market'));

test('valid minimal legacy stock archives still open without recomputing historical conclusions',async()=>inPage(async page=>{
  await page.getByRole('tab',{name:/复盘档案/}).click();await page.getByText('合成有效记录',{exact:true}).click();
  await page.locator('.review-stock-hero').waitFor();
  assert.match(await page.locator('.review-stock-hero').innerText(),/浦发银行/);
  assert.equal(await page.getByText('旧结构记录未保存有序证据摘要',{exact:true}).count(),1);
},'?review=1'));


test('valid primary rows survive partial corruption even when an older complete backup exists',async()=>inPage(async page=>{
  const original=await page.evaluate(()=>localStorage.getItem('a-stock-radar-professional-review-v1'));
  await page.getByRole('tab',{name:/复盘档案/}).click();await page.getByText('合成有效记录',{exact:true}).waitFor();
  assert.equal(await page.getByText('合成完整备份',{exact:true}).count(),0);
  assert.equal(await page.evaluate(()=>localStorage.getItem('a-stock-radar-professional-review-v1')),original);
},'?review=mixed-backup'));
