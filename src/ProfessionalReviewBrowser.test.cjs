'use strict';
const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
let server, browser, url;
before(async () => {
  const { createServer } = await import('vite');
  const marketSnapshot = require('../electron/review-service.cjs').buildProfessionalReviewSnapshot({generatedAt:'2026-10-01T08:00:00Z'});
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import Review from '/src/ProfessionalReview.tsx';
    window.stockApi={getProfessionalReview:()=>new Promise(()=>{})};
    localStorage.setItem('a-stock-radar-professional-review-v1',JSON.stringify([null,{id:'bad',title:{nested:'bad'},type:'stock'}, {id:'ok',type:'stock',title:'合成有效记录',date:'2026-10-01',score:50,verdict:'合成条件',note:'',createdAt:'2026-10-01T02:00:00Z',snapshot:{security:{code:'600000',name:'浦发银行'}}}]));
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
    root.render(React.createElement(Review));
  </script></body></html>`;
  server = await createServer({plugins:[{name:'signal-polish-fixture',configureServer(vite){vite.middlewares.use(async(request,response,next)=>{if(!request.url.startsWith('/__signal_polish__'))return next();try{response.setHeader('Content-Type','text/html');response.end(await vite.transformIndexHtml(request.url,html));}catch(error){next(error);}});}}],server:{host:'127.0.0.1',port:0,strictPort:false},logLevel:'error'});
  await server.listen(); url=`http://127.0.0.1:${server.httpServer.address().port}/__signal_polish__`;
  browser=await require('playwright-core').chromium.launch({executablePath:process.env.QA_CHROMIUM_PATH||'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
});
after(async()=>{await browser?.close();await server?.close();});
async function inPage(run,suffix='') {const page=await browser.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));page.setDefaultTimeout(3000);try{await page.goto(url+suffix);await run(page);assert.deepEqual(errors,[]);}finally{await page.close();}}

test('corrupt archive rows cannot crash the archive tab and valid records remain visible',async()=>inPage(async page=>{
  await page.getByRole('tab',{name:/复盘档案/}).click();await page.getByText('合成有效记录',{exact:true}).waitFor();
  assert.equal(await page.locator('.review-archive-list > button').count(),1);
},'?review=1'));



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
