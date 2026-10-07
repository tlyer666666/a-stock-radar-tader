"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright-core");

async function run() {
  const browser = await chromium.launch({executablePath: process.env.CHROME_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true});
  const page = await browser.newPage({viewport: {width:1480,height:1050}, acceptDownloads:true});
  const errors=[]; page.on("pageerror", error => errors.push(error.message));
  const output=path.resolve(process.env.TREND_QA_OUTPUT || "artifacts/trend-screener-qa"); fs.mkdirSync(output,{recursive:true});
  try {
    await page.goto(process.env.TREND_QA_URL || "http://127.0.0.1:5173",{waitUntil:"networkidle"});
    await page.getByRole("heading",{name:"趋势筛选",exact:true}).waitFor();
    assert.equal(await page.getByRole("button",{name:"涨停趋势",exact:true}).getAttribute("aria-current"),"page");
    assert.equal(await page.locator(".strategy-quick-trigger").count(),0);
    await page.getByText("DEMO / 演示工作台 · 全部证券均为虚构",{exact:true}).waitFor();
    assert.equal(await page.locator(".trend-candidate").count(),3);
    await page.screenshot({path:path.join(output,"workspace.png"),fullPage:true});
    await page.getByRole("button",{name:/^A 回踩转强/}).click();
    assert.equal(await page.locator(".trend-candidate").count(),1);
    await page.locator(".trend-candidate").getByRole("button",{name:/规则依据/}).click();
    assert.ok(await page.locator(".trend-evidence").isVisible());
    await page.getByRole("button",{name:"加入我的计划",exact:true}).click();
    await page.getByRole("button",{name:/^我的计划/}).click();
    assert.equal(await page.locator(".trend-candidate").count(),1);
    await page.locator(".trend-calculator > summary").click();
    await page.getByLabel("账户净资产",{exact:true}).fill("125000");
    await page.getByRole("checkbox",{name:/当前账户已持有该股/}).check();
    await page.getByRole("checkbox",{name:/已核实板块权限/}).check();
    await page.reload({waitUntil:"networkidle"});
    await page.getByRole("button",{name:/^我的计划/}).click();
    await page.locator(".trend-calculator > summary").click();
    assert.equal(await page.getByLabel("账户净资产",{exact:true}).inputValue(),"125000");
    assert.equal(await page.getByRole("checkbox",{name:/当前账户已持有该股/}).isChecked(),true);
    assert.equal(await page.getByRole("checkbox",{name:/已核实板块权限/}).isChecked(),false);
    const downloadPromise=page.waitForEvent("download");
    await page.getByRole("button",{name:"导出计划 CSV",exact:true}).click();
    const download=await downloadPromise;
    const csv=fs.readFileSync(await download.path(),"utf8");
    assert.match(csv,/DEMO/); assert.match(csv,/DEMO-A01/); assert.match(csv,/11.42/);
    await page.getByRole("button",{name:/^研究候选/}).click();
    await page.getByLabel("搜索代码或名称",{exact:true}).fill("DEMO-B02");
    assert.equal(await page.locator(".trend-candidate").count(),1);
    await page.getByRole("button",{name:"清空候选搜索",exact:true}).click();
    await page.getByRole("button",{name:"方案算例",exact:true}).click();
    const example=page.getByRole("region",{name:"虚构方案算例",exact:true});
    await example.getByRole("button",{name:"计算参考股数",exact:true}).click();
    // The example still requires explicit acknowledgement of the hypothetical checks.
    for (const checkbox of await example.getByRole("checkbox").all()) {
      if (!(await checkbox.locator("..").innerText()).includes("当前账户已持有")) await checkbox.check();
    }
    await example.getByRole("button",{name:"计算参考股数",exact:true}).click();
    assert.match(await example.locator(".trend-sizing-values").innerText(),/1,000 股/);
    assert.match(await example.locator(".trend-sizing-values").innerText(),/500.00 \/ 0.50%/);
    await example.getByRole("button",{name:"持有 / 退出复核",exact:true}).click();
    await example.getByLabel("实际持有交易日",{exact:true}).fill("29");
    await example.getByLabel("本日收盘",{exact:true}).fill("10");
    await example.getByLabel("本日 MA20",{exact:true}).fill("9.8");
    await example.getByRole("checkbox").check();
    await example.getByRole("button",{name:"复核退出条件",exact:true}).click();
    await example.getByText("第 29 个持仓交易日收盘，安排第 30 日开盘退出",{exact:true}).waitFor();
    await example.screenshot({path:path.join(output,"plan-exit.png")});
    await page.getByRole("button",{name:"方案算例",exact:true}).click();
    await page.setViewportSize({width:760,height:1000});
    await page.locator(".main > .page").evaluate(el=>el.scrollTo(0,0));
    await page.screenshot({path:path.join(output,"narrow.png"),fullPage:true});
    assert.equal(await page.locator(".trend-screener").evaluate(el=>el.scrollWidth>el.clientWidth+2),false);
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+2),false);
    await page.evaluate(()=>{
      const original=window.stockApi.getTrendScan;
      window.stockApi.startTrendScan=async()=>({...await original(),isPreview:false,phase:"scanning",candidates:[],coverageComplete:false});
      window.stockApi.getTrendScan=async()=>({...await original(),isPreview:false,phase:"scanning",candidates:[],coverageComplete:false});
      window.stockApi.cancelTrendScan=async()=>({...await original(),isPreview:false,phase:"cancelled",candidates:[],coverageComplete:false});
    });
    await page.getByRole("button",{name:"扫描全 A 股",exact:true}).first().click();
    await page.getByRole("button",{name:"取消扫描",exact:true}).click();
    await page.getByRole("heading",{name:"扫描已取消",exact:true}).waitFor();
    await page.evaluate(()=>{window.stockApi.startTrendScan=async()=>{throw new Error("测试接口暂不可用");};});
    await page.getByRole("button",{name:"扫描全 A 股",exact:true}).first().click();
    await page.getByRole("alert").filter({hasText:"启动扫描失败：测试接口暂不可用"}).waitFor();
    assert.deepEqual(errors,[]);
    console.log("Trend workflow passed: default home, A filter/evidence, persisted plan/draft, CSV, search, Word sizing, day29 exit, responsive layout, scan/cancel/error.");
  } finally {await browser.close();}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
