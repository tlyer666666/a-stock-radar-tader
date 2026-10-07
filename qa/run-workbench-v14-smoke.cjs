"use strict";
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require('playwright-core');
const { getStrategyDefinitions } = require('../electron/services.cjs');

async function main() {
  const output=path.resolve('artifacts/v14-qa');fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',headless:true});
  const page=await browser.newPage({viewport:{width:1480,height:1050}});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const shots=[];
  try {
    await page.goto(process.env.QA_BASE_URL||'http://127.0.0.1:5175',{waitUntil:'networkidle'});
    await page.getByRole('button',{name:'黑夜',exact:true}).click();
    assert.equal(await page.locator('.workspace-nav-group').count(),3);
    assert.equal(await page.locator('.trend-library-choice').count(),14);
    await page.getByLabel('查找趋势策略').fill('RSI');assert.equal(await page.locator('.trend-library-choice').count(),1);
    await page.getByLabel('查找趋势策略').fill('');
    await page.getByRole('button',{name:'收起导航栏',exact:true}).click();assert.equal(await page.locator('.terminal-shell').getAttribute('data-nav-collapsed'),'true');
    await page.getByRole('button',{name:'展开导航栏',exact:true}).click();
    for(const width of [1480,1024,760]) {
      await page.setViewportSize({width,height:1050});
      assert.equal(await page.locator('.main > .page').evaluate(e=>e.scrollWidth>e.clientWidth+2),false,`trend ${width} overflow`);
      const name=`trend-${width}-dark.png`;await page.screenshot({path:path.join(output,name)});shots.push(name);
    }
    await page.setViewportSize({width:1480,height:1050});
    await page.evaluate(definitions=>{
      window.stockApi.getStrategyDefinitions=async()=>definitions;
      window.stockApi.scanStrategySignals=()=>new Promise(()=>{});
      window.__queries=[];
      window.stockApi.search=async q=>{ window.__queries.push(q); await new Promise(r=>setTimeout(r,q==='旧股票'?600:20));return q==='旧股票'?[{code:'000001',name:'旧股票',secid:'0.000001',assetType:'stock'}]:q==='不存在'?[]:[{code:'600000',name:'浦发银行',secid:'1.600000',assetType:'stock'}]; };
      window.__backtest=null;
      window.stockApi.runBacktest=async(security,options)=>{window.__backtest={security,options};throw Error('界面验收：已捕获真实请求结构，未执行收益模拟');};
    },getStrategyDefinitions());
    await page.getByRole('button',{name:'策略信号',exact:true}).click();
    await page.getByLabel('测试股票：代码或名称').waitFor();
    assert.equal(await page.locator('.strategy-signal-tab-list button').count(),32,'catalog available before slow market scan');
    assert.equal(await page.getByRole('button',{name:'测试这只股票',exact:true}).isEnabled(),false);
    const input=page.getByLabel('测试股票：代码或名称');
    await input.fill('旧股票');await page.waitForFunction(()=>window.__queries.includes('旧股票'));
    await input.fill('600000');await page.getByRole('option',{name:/浦发银行/}).waitFor();
    await page.waitForTimeout(650);assert.equal(await page.getByRole('option',{name:/旧股票/}).count(),0);
    await input.press('ArrowDown');await input.press('Enter');
    assert.equal(await page.getByRole('button',{name:'测试这只股票',exact:true}).isEnabled(),true);
    await input.fill('不存在');assert.equal(await page.getByRole('button',{name:'测试这只股票',exact:true}).isEnabled(),false);
    await page.getByText('没有可测试的非ST A股，请更换代码或名称。',{exact:true}).waitFor();
    await input.fill('600000');await page.getByRole('option',{name:/浦发银行/}).click();
    for(const [width,theme] of [[1480,'dark'],[1024,'dark'],[760,'dark'],[1480,'light']]) {
      await page.setViewportSize({width,height:1050});await page.getByRole('button',{name:theme==='light'?'白天':'黑夜',exact:true}).click();
      await page.locator('.main > .page').evaluate(e=>e.scrollTo(0,0));
      assert.equal(await page.locator('.main > .page').evaluate(e=>e.scrollWidth>e.clientWidth+2),false,`signals ${width} ${theme} overflow`);
      const name=`signals-${width}-${theme}.png`;await page.screenshot({path:path.join(output,name)});shots.push(name);
    }
    const activeName=await page.locator('.strategy-signal-title-line h2').innerText();
    await page.getByRole('button',{name:'测试这只股票',exact:true}).click();
    await page.locator('[data-single-stock-backtest]').waitFor();
    assert.match(await page.locator('.backtest-context-grid').innerText(),/浦发银行[\s\S]*600000/);
    assert.ok((await page.locator('.backtest-context-grid').innerText()).includes(activeName));
    const run=page.locator('[data-single-stock-backtest]').locator('..').getByRole('button',{name:/运行.*回测|开始.*回测/});
    if(await run.count())await run.first().click();else await page.getByRole('button',{name:/运行.*回测|开始.*回测/}).first().click();
    await page.waitForFunction(()=>Boolean(window.__backtest));
    const captured=await page.evaluate(()=>window.__backtest);
    assert.equal(captured.security.code,'600000');assert.equal(captured.options.strategyContext.strategyName,activeName);
    assert.equal(captured.options.strategyContext.strategyIds.length,1);
    assert.deepEqual(errors,[]);
    fs.writeFileSync(path.join(output,'workbench-smoke.json'),JSON.stringify({passed:true,syntheticInterfaceOnly:true,trendOptions:14,signalOptions:32,checks:['grouped navigation/collapse','trend search','catalog usable while scan pending','stock selection required','late search isolated','edited query clears selection','keyboard selection','manual stock+strategy carried into actual backtest API','dark/light and 760/1024/1480 no page overflow'],screenshots:shots,pageErrors:errors},null,2));
    console.log('Workbench v1.4 smoke passed; synthetic UI data, no return claim.');
  } finally {await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
