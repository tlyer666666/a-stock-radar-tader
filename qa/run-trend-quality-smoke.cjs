'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {chromium} = require('playwright-core');
async function run() {
 const browser = await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
 const page = await browser.newPage({viewport:{width:1480,height:1050},acceptDownloads:true});
 const output = path.resolve('artifacts/strategy-v2-qa');fs.mkdirSync(output,{recursive:true});
 const errors=[];page.on('pageerror', e=>errors.push(e.message));
 try {
  await page.goto(process.env.QA_BASE_URL || 'http://127.0.0.1:5173',{waitUntil:'networkidle'});
  await page.getByRole('heading',{name:'趋势筛选',exact:true}).waitFor();
  await page.getByRole('button',{name:'单策略扫描',exact:true}).click();
  assert.equal(await page.getByLabel('扫描策略',{exact:true}).inputValue(),'quality-v2');
  await page.getByRole('button',{name:'扫描全 A 股',exact:true}).first().click();
  await page.locator('.trend-strategy-current').getByText(/1 个策略 · 趋势质量 v2/).waitFor();
  const initial = await page.evaluate(()=>window.stockApi.getTrendScan());
  assert.equal(initial.strategy.id,'quality-v2');assert.equal(initial.strategy.config.maxExtensionAtr,2);
  let card=page.locator('.trend-candidate[data-code="DEMO-A01"]');
  await card.getByRole('button',{name:'加入我的计划',exact:true}).click();
  await card.locator('.trend-calculator > summary').click();
  for(const [label,value] of Object.entries({'账户净资产':'100000','拟成交价 P':'12.29','可用现金':'100000','已有同业仓位':'0','已有总仓位':'0','已有持仓数量':'0','预留费用':'0','该股最低买入数量':'100','该股申报递增单位':'100'})) await card.getByLabel(label,{exact:true}).fill(value);
  for(const cb of await card.getByRole('checkbox').all())if(!(await cb.locator('..').innerText()).includes('当前账户已持有'))await cb.check();
  await card.getByRole('button',{name:'计算参考股数',exact:true}).click();
  await card.getByText('拟成交价低于冻结突破下限，取消本次入场',{exact:true}).waitFor();
  assert.equal(await card.locator('.trend-sizing-values').count(),0);
  await card.getByLabel('拟成交价 P',{exact:true}).fill('12.30');
  await card.getByRole('button',{name:'计算参考股数',exact:true}).click();
  await card.locator('.trend-sizing-values').waitFor();
  await page.evaluate(() => {
   const original=window.stockApi.getTrendScan;
   window.stockApi.getTrendScan=async()=>{const state=await original();state.candidates[0].plan.stop=11.60;state.candidates[0].plan.minEntry=12.35;return state;};
   window.__restoreTrendStatus=()=>{window.stockApi.getTrendScan=original;};
  });
  await page.getByRole('button',{name:'刷新扫描状态',exact:true}).click();
  await page.waitForTimeout(150);
  assert.match(await page.locator('.trend-candidate[data-code="DEMO-A01"] .trend-reference-plan').innerText(),/11.42/, 'same-date correction must not replace saved stop');
  assert.match(await page.locator('.trend-candidate[data-code="DEMO-A01"] .trend-reference-plan').innerText(),/12.30/, 'same-date correction must not replace saved floor');
  await page.evaluate(()=>window.__restoreTrendStatus());
  await page.getByRole('button',{name:'均衡',exact:true}).click();
  await page.getByRole('button',{name:'扫描全 A 股',exact:true}).first().click();
  await page.waitForFunction(async h=>(await window.stockApi.getTrendScan()).strategy.configHash!==h,initial.strategy.configHash);
  const balanced=await page.evaluate(()=>window.stockApi.getTrendScan());assert.equal(balanced.strategy.config.maxExtensionAtr,2.5);
  await page.locator('.trend-candidate[data-code="DEMO-A01"]').getByRole('button',{name:'加入我的计划',exact:true}).click();
  await page.getByLabel('最大均线偏离（ATR）',{exact:true}).fill('99');
  await page.getByRole('button',{name:'扫描全 A 股',exact:true}).first().click();
  await page.getByRole('alert').filter({hasText:'三个有效参数'}).waitFor();
  assert.equal((await page.evaluate(()=>window.stockApi.getTrendScan())).strategy.configHash,balanced.strategy.configHash);
  await page.getByLabel('扫描策略',{exact:true}).selectOption('classic-v1');
  await page.getByRole('button',{name:'扫描全 A 股',exact:true}).first().click();
  await page.locator('.trend-strategy-current').getByText(/1 个策略 · 原版趋势 v1/).waitFor();
  await page.getByRole('button',{name:/^我的计划/}).click();
  assert.equal(await page.locator('.trend-candidate').count(),2);
  for(const c of await page.locator('.trend-candidate').all()) assert.match(await c.locator('.trend-reference-plan').innerText(),/12.30/);
  await page.locator('.trend-candidate').first().locator('.trend-calculator > summary').click();
  card=page.locator('.trend-candidate').first();
  // A classic result cannot supply the market gate for a quality snapshot.
  for(const [label,value] of Object.entries({'账户净资产':'100000','拟成交价 P':'12.30','可用现金':'100000','已有同业仓位':'0','已有总仓位':'0','已有持仓数量':'0','预留费用':'0','该股最低买入数量':'100','该股申报递增单位':'100'}))await card.getByLabel(label,{exact:true}).fill(value);
  for(const cb of await card.getByRole('checkbox').all())if(!(await cb.locator('..').innerText()).includes('当前账户已持有'))await cb.check();
  await card.getByRole('button',{name:'计算参考股数',exact:true}).click();
  assert.equal(await card.locator('.trend-sizing-values').count(),0);
  assert.match(await card.locator('.trend-calculation-result').innerText(),/市场/);
  const downloadP=page.waitForEvent('download');await page.getByRole('button',{name:'导出计划 CSV',exact:true}).click();
  const csv=fs.readFileSync(await(await downloadP).path(),'utf8');assert.match(csv,/quality-v2@2.0.0/);assert.match(csv,/最低参考入场/);assert.match(csv,/DEMO/);
  await page.reload({waitUntil:'networkidle'});await page.getByRole('button',{name:/^我的计划/}).click();assert.equal(await page.locator('.trend-candidate').count(),2);
  await page.getByRole('button',{name:/^研究候选/}).click();await page.getByRole('button',{name:'扫描全 A 股',exact:true}).first().click();
  for(const [width,theme] of [[1480,'dark'],[1024,'dark'],[760,'dark'],[1480,'light']]){
   await page.setViewportSize({width,height:1050});await page.getByRole('button',{name:theme==='dark'?'黑夜':'白天',exact:true}).count().then(async count=>{if(count) await page.getByRole('button',{name:theme==='dark'?'黑夜':'白天',exact:true}).click(); else await page.getByRole('button',{name:theme==='dark'?'暮夜':'白昼',exact:true}).click();});
   await page.locator('.main > .page').evaluate(el=>el.scrollTo(0,0));
   assert.equal(await page.locator('.trend-screener').evaluate(el=>el.scrollWidth>el.clientWidth+2),false,`${width} ${theme}`);
   await page.screenshot({path:path.join(output,`quality-${width}-${theme}.png`),fullPage:true});
  }
  assert.deepEqual(errors,[]);
  fs.writeFileSync(path.join(output,'ui-workflow.json'),JSON.stringify({passed:true,checks:['quality defaults','IPC-compatible request','min entry sizing floor','config plan identity','invalid parameters rejected','classic/quality snapshot isolation','CSV metadata','reload persistence','1480/1024/760 responsive','dark/light'],previewOnly:true},null,2));
  console.log('Quality UI smoke passed: parameter round-trip, entry floor, saved config isolation, CSV, reload, responsive themes.');
 } finally {await browser.close();}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
