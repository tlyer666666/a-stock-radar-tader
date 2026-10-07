'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright-core');
async function main(){
 const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1480,height:1050}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 const output=path.resolve('artifacts/usability-v13-qa');fs.mkdirSync(output,{recursive:true});
 try{
  await page.goto(process.env.QA_BASE_URL||'http://127.0.0.1:5175',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'趋势筛选',exact:true}).waitFor();
  assert.equal(await page.locator('.brand').count(),0);
  assert.doesNotMatch(await page.locator('body').innerText(),/近期涨停 · 上涨趋势|参数用于下一次扫描|2–6 周 · A股波段工作台|下一段上升趋势/);
  assert.equal(await page.locator('#trend-principle').count(),0);
  await page.getByRole('button',{name:'筛选原理',exact:true}).click();
  await page.locator('#trend-principle').waitFor();
  assert.match(await page.locator('#trend-principle').innerText(),/近期涨停本身不是买入理由/);
  await page.locator('#trend-principle').getByRole('button',{name:'收起',exact:true}).click();
  await page.evaluate(()=>{
   const original=window.stockApi.getTrendScan;
   window.stockApi.getTrendScan=async()=>({...await original(),isPreview:true,phase:'completed',coverageComplete:false,
    diagnostics:{funnel:{universeEligible:500,rawValidated:420,recentLimitPassed:38,trendPassed:12,technicalTriggered:4,riskPassed:2},
    sources:[{stage:'raw',source:'合成验收源',status:'ok',successes:420,failures:0,latestDate:'2026-09-30',detail:'仅验收UI，非真实数据',crossCheckedRows:320},{stage:'adjusted',source:'合成失败源',status:'error',successes:0,failures:2,latestDate:null,detail:'缺少可验证复权数据',crossCheckedRows:0}],reasons:[{stage:'data',reason:'复权不可用',count:2}]}});
  });
  await page.getByRole('button',{name:'刷新扫描状态',exact:true}).click();
  await page.locator('.trend-diagnostics').waitFor();
  assert.equal(await page.locator('[data-funnel-stage]').count(),6);
  await page.locator('.trend-source-details > summary').click();
  assert.match(await page.locator('.trend-source-details').innerText(),/缺少可验证复权数据/);
  for(const width of [1480,1024,760]){
   await page.setViewportSize({width,height:1050});
   await page.getByRole('button',{name:/^(黑夜|暮夜)$/}).click();
   await page.waitForTimeout(250);
   assert.equal(await page.locator('.trend-screener').evaluate(e=>e.scrollWidth>e.clientWidth+2),false,`trend ${width}`);
   await page.screenshot({path:path.join(output,`trend-${width}-dark.png`),fullPage:true});
  }
  await page.setViewportSize({width:1480,height:1050});
  await page.evaluate(()=>{
   const make=(code,height,turnover,extra={})=>({code,name:'合成'+code,secid:'1.'+code,assetType:'stock',consecutiveBoards:height,turnover,limitDate:'2026-09-30',industry:'验收板块',firstSealTime:'09:35:00',openBoardCount:0,...extra});
   window.__ladderRows=[make('600101',2,8),make('600102',5,3),make('600103',2,2),make('600104',3,null),make('600105',2,null),make('600106',8,15,{limitDate:'2026-09-29'}),make('600107',3,1,{name:'ST合成'}),make('600108',1,5)];
   window.stockApi.getLimitUpPoolSnapshot=async()=>({rows:window.__ladderRows,meta:{dataDate:'2026-09-30',fetchedAt:new Date().toISOString(),providers:['synthetic-qa']}});
   window.stockApi.discoverRecentLimitUps=async()=>[];
  });
  await page.getByRole('button',{name:'观察池',exact:true}).click();
  await page.locator('.board-ladder-level').first().waitFor();
  const heights=()=>page.locator('[data-board-height]').evaluateAll(es=>es.map(e=>Number(e.dataset.boardHeight)));
  assert.deepEqual(await heights(),[5,3,2]);
  assert.equal(await page.locator('.board-ladder-stock').count(),5);
  assert.match(await page.locator('[data-code="600104"]').innerText(),/待补/);
  assert.match(await page.locator('[data-code="600102"]').innerText(),/0次/);
  await page.getByRole('button',{name:/^换手率/}).click();
  const codes=()=>page.locator('[data-board-height="2"] .board-ladder-stock').evaluateAll(es=>es.map(e=>e.dataset.code));
  assert.deepEqual(await codes(),['600103','600101','600105']);
  await page.getByRole('button',{name:/^换手率/}).click();
  assert.deepEqual(await codes(),['600101','600103','600105']);assert.deepEqual(await heights(),[5,3,2]);
  for(const [width,theme] of [[1480,'dark'],[1024,'dark'],[760,'dark'],[1480,'light']]){
   await page.setViewportSize({width,height:1050});
   await page.getByRole('button',{name:theme==='dark'?/^(黑夜|暮夜)$/:/^(白天|白昼)$/}).click();
   await page.waitForTimeout(250);
   const overflow=await page.locator('.board-ladder').evaluate(e=>e.scrollWidth>e.clientWidth+2);assert.equal(overflow,false,`ladder ${width} ${theme}`);
   const [left,right]=await Promise.all([page.locator('.board-ladder-height').first().boundingBox(),page.locator('.board-ladder-stocks').first().boundingBox()]);
   assert.ok(left.x+left.width<=right.x+1,`board count stays left at ${width}`);
   await page.locator('.board-ladder').screenshot({path:path.join(output,`watch-ladder-${width}-${theme}.png`)});
  }
  await page.locator('[data-code="600102"]').click();
  await page.getByRole('button',{name:/返回.*观察池/}).first().waitFor();
  await page.getByRole('button',{name:/返回.*观察池/}).first().click();
  await page.locator('.board-ladder-level').first().waitFor();assert.deepEqual(await heights(),[5,3,2]);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'usability-ui.json'),JSON.stringify({passed:true,syntheticUiOnly:true,checks:['removed branding and persistent slogans','optional principle toggle','partial source failures and six-stage counts','ladder height ordering','within-height sorting and null handling','date and ST isolation','open stock and return','1480/1024/760 dark + 1480 light layout']},null,2));
  console.log('Usability 1.3 browser smoke passed (synthetic UI only).');
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
