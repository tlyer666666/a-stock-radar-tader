"use strict";
// Synthetic evidence only. This verifies UI/archival behavior, not real-market performance.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");
const { buildProfessionalReviewSnapshot } = require("../electron/review-service.cjs");

const history = Array.from({length:70},(_,i)=>{const close=10+i*.05;return {date:new Date(Date.UTC(2026,6,23+i)).toISOString().slice(0,10),open:close-.02,high:close+.08,low:close-.08,close,volume:1000000,amount:200000000};});
const security={code:"600001",name:"合成趋势样本",assetType:"stock",secid:"1.600001"};
const payload={security,quote:{...security,latest:history.at(-1).close,amount:200000000},history,actualProvider:"synthetic-qa",updatedAt:"2026-09-30T08:00:00Z",analysis:{mrs:99,maBull:true,slopesUp:true,limitEvent:{date:history.at(-8).date,low:history.at(-8).low},rsSector:2,qualification:{riskVetoPassed:true}},sector:{name:"合成行业"}};
const market=buildProfessionalReviewSnapshot({generatedAt:payload.updatedAt,emotion:{date:"2026-09-30",limitUpCount:50,limitDownCount:5,score:90},market:{stockCount:100,upCount:60,downCount:35,flatCount:5,breadth:.6},indices:[{definition:{code:"000985",name:"合成中证全指"},chart:{rows:history}}],sectors:[{name:"合成行业",score:75,poolLimitUps:8,relativeReturn:2}],ladderPools:{currentPool:[{...security,consecutiveBoards:1}],failedPool:[],failedPoolAvailable:true}});
market.decision.sourceNature="合成 UI 验收资料，不是实盘验证";
async function main(){
 const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",headless:true});
 const page=await browser.newPage({viewport:{width:1480,height:1150}}),errors=[];
 const output=path.resolve("artifacts/professional-review-v13-qa");fs.mkdirSync(output,{recursive:true});
 page.on("pageerror",e=>errors.push(e.message));
 try{
  await page.goto(process.env.QA_BASE_URL||"http://127.0.0.1:5174",{waitUntil:"networkidle"});
  await page.evaluate(({market,payload})=>{
   window.__reviewFixture={market,payload};
   window.stockApi.getProfessionalReview=async()=>structuredClone(window.__reviewFixture.market);
   window.stockApi.analyze=async()=>structuredClone(window.__reviewFixture.payload);
   window.stockApi.search=async()=>[window.__reviewFixture.payload.security];
  },{market,payload});
  await page.locator('[data-professional-review-nav="true"]').click();
  const summary=page.locator('.review-decision');
  await summary.getByRole('heading',{name:'市场趋势可观察，个股条件另核'}).waitFor();
  assert.equal(await summary.locator('[data-step]').count(),5);
  assert.doesNotMatch(await summary.innerText(),/胜率|\/100|条件仓位区间/);
  assert.equal(await page.locator('.review-legacy-details').getAttribute('open'),null);
  await page.locator('.review-legacy-details > summary').click();
  assert.equal(await page.locator('.review-dimension').count(),8);
  assert.doesNotMatch(await page.locator('.review-exposure').innerText(),/\d+%/);
  await page.locator('.review-legacy-details > summary').click();
  await page.screenshot({path:path.join(output,'market-1480-dark.png'),fullPage:true});
  await page.getByRole('tab',{name:'个股复盘',exact:true}).click();
  await page.getByPlaceholder('搜索 A股、ETF、可转债（代码或名称）').fill('600001');
  await page.getByRole('button',{name:'开始复盘',exact:true}).click();
  await summary.getByRole('heading',{name:'趋势延续观察 · 交易条件待核验'}).waitFor();
  assert.match(await summary.innerText(),/合成 \/ 预览资料/);
  await page.locator('.review-legacy-details > summary').click();
  assert.equal(await page.locator('.review-factor').count(),20);
  assert.match(await page.locator('.review-trade-plan').innerText(),/未冻结/);
  assert.match(await page.locator('.review-trade-plan').innerText(),/失效价\s*--/);
  await page.locator('.review-legacy-details > summary').click();
  await page.locator('.review-journal textarea').fill('合成验收：保存当日有序证据，未冻结执行计划。');
  await page.locator('.review-journal button').click();
  const archived=await page.evaluate(()=>JSON.parse(localStorage.getItem('a-stock-radar-professional-review-v1')));
  assert.equal(archived[0].snapshot.decision.version,'ordered-evidence-v2');
  assert.equal(archived[0].snapshot.plan.stop,null);
  await page.locator('.review-toast').waitFor({state:'hidden'});
  for(const [width,theme] of [[1480,'dark'],[760,'dark'],[1480,'light']]){
   await page.setViewportSize({width,height:1150});
   await page.getByRole('button',{name:theme==='dark'?/^(黑夜|暮夜)$/:/^(白天|白昼)$/}).click();
   await page.waitForTimeout(250);
   await page.locator('.review-page-host').evaluate(e=>e.scrollTo(0,0));
   assert.equal(await summary.evaluate(e=>e.scrollWidth>e.clientWidth+2),false,`${width} ${theme} summary overflow`);
   assert.equal(await page.locator('.review-page-host').evaluate(e=>e.scrollWidth>e.clientWidth+2),false,`${width} ${theme} page overflow`);
   await page.screenshot({path:path.join(output,`stock-${width}-${theme}.png`),fullPage:true});
   if(width===1480){
    await summary.locator('[data-step="next"]').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(output,`stock-next-${theme}.png`),fullPage:true});
   }
  }
  // A live market refresh cannot overwrite an archive opened while it was in flight.
  await page.evaluate(()=>{window.stockApi.getProfessionalReview=()=>new Promise(resolve=>{window.__finishOldMarket=()=>resolve({...window.__reviewFixture.market,decision:{...window.__reviewFixture.market.decision,headline:'不应出现的旧请求'}});});});
  await page.getByRole('tab',{name:'市场复盘',exact:true}).click();
  await page.getByRole('button',{name:'重新计算',exact:true}).click();
  await page.getByRole('tab',{name:/复盘档案 1/}).click();
  await page.locator('.review-archive-list button').click();
  await page.evaluate(()=>window.__finishOldMarket());
  await page.getByRole('tab',{name:'市场复盘',exact:true}).click();
  assert.doesNotMatch(await summary.innerText(),/不应出现的旧请求/);
  // New stock errors must not be presented as a complete directional conclusion.
  await page.evaluate(()=>{window.__reviewFixture.payload.history=[];});
  await page.getByRole('tab',{name:'个股复盘',exact:true}).click();
  await page.getByRole('button',{name:'开始复盘',exact:true}).click();
  await summary.getByRole('heading',{name:'数据不足，阶段暂不可判'}).waitFor();
  await page.screenshot({path:path.join(output,'stock-missing.png'),fullPage:true});
  await page.evaluate(({payload})=>{window.__reviewFixture.payload=structuredClone(payload);window.__reviewFixture.payload.security.name='*ST合成';},{payload});
  await page.getByRole('button',{name:'开始复盘',exact:true}).click();
  await summary.getByRole('heading',{name:'趋势延续观察 · 规则不通过'}).waitFor();
  assert.match(await summary.locator('[data-step="conflicts"]').innerText(),/ST/);
  // Reopen the snapshot: never refill missing/old records using today's market.
  await page.getByRole('tab',{name:/复盘档案 1/}).click();
  await page.locator('.review-archive-list button').click();
  await summary.getByRole('heading',{name:'趋势延续观察 · 交易条件待核验'}).waitFor();
  await page.reload({waitUntil:'networkidle'});
  await page.locator('[data-professional-review-nav="true"]').click();
  await page.getByRole('tab',{name:/复盘档案 1/}).click();
  await page.locator('.review-archive-list button').click();
  await summary.getByRole('heading',{name:'趋势延续观察 · 交易条件待核验'}).waitFor();
  await page.evaluate(()=>{const records=JSON.parse(localStorage.getItem('a-stock-radar-professional-review-v1'));delete records[0].snapshot.decision;localStorage.setItem('a-stock-radar-professional-review-v1',JSON.stringify(records));});
  await page.reload({waitUntil:'networkidle'});
  await page.locator('[data-professional-review-nav="true"]').click();
  await page.getByRole('tab',{name:/复盘档案 1/}).click();
  await page.locator('.review-archive-list button').click();
  await summary.getByRole('heading',{name:'旧结构记录未保存有序证据摘要'}).waitFor();
  assert.match(await summary.innerText(),/不追溯补造阶段/);
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'smoke.json'),JSON.stringify({passed:true,syntheticUiOnly:true,checks:['five ordered evidence steps','no primary score/exposure','eight/twenty folded details','missing prices remain null','market vs stock scope','archive saves/reopens/reloads exact summary','old in-flight response isolation','missing data distinct from rule rejection','desktop/narrow dark/light']},null,2));
  console.log('Professional review decision smoke passed (synthetic UI fixtures only).');
 }finally{await browser.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
