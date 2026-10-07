"use strict";
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");

let server;
let browser;
let url;
before(async () => {
  const { createServer } = await import("vite");
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import Editor from '/src/StockMonitorEditor.tsx';
    import useStockMonitors from '/src/useStockMonitors.ts';
    import '/src/styles.css';
    window.nextQuote={latest:10,changePct:1,turnover:2,amount:50000,source:'eastmoney'};
    window.sampleTime=Date.now()-2000;
    window.stockApi={getQuoteSnapshot:async()=>({quote:structuredClone(window.nextQuote),updatedAt:new Date(window.sampleTime+=10).toISOString(),actualProvider:'eastmoney'})};
    const stock={code:'600000',name:'测试股票',secid:'1.600000'};
    const items=[stock];
    function Fixture(){
      const [live,setLive]=React.useState(false);
      window.changeLive=setLive;
      const monitors=useStockMonitors({items,live,refreshSeconds:5});
      window.monitors=monitors;
      return React.createElement('main',{style:{padding:24}},React.createElement(Editor,{stock,config:monitors.configs[stock.code],onSave:config=>{window.saveResult=monitors.save(stock.code,config);return window.saveResult},onCancel:()=>{window.cancelled=true}}),React.createElement('p',{role:'status'},monitors.storageError));
    }
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  </script></body></html>`;
  server = await createServer({ plugins: [{ name: "stock-monitor-editor-fixture", configureServer(vite) { vite.middlewares.use(async (request, response, next) => { if (request.url !== "/__monitor_editor__") return next(); try { response.setHeader("Content-Type", "text/html"); response.end(await vite.transformIndexHtml(request.url, html)); } catch (error) { next(error); } }); } }], server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/__monitor_editor__`;
  browser = await require("playwright-core").chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function inPage(run) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(5000);
  try { await page.goto(url); await page.getByRole("heading", { name: /自定义监控/ }).waitFor(); await run(page); assert.deepEqual(errors, []); }
  finally { await page.close(); }
}

test("editor requires explicit thresholds and saves amount in yuan with ANY/disabled configuration across reload", async () => inPage(async page => {
  await page.getByRole("button", { name: "保存条件", exact: true }).click();
  assert.match(await page.getByRole("alert").innerText(), /填写/);
  assert.equal(await page.evaluate(() => window.monitors.configs["600000"]), undefined);
  await page.getByLabel("条件 1 指标", { exact: true }).selectOption("amount");
  await page.getByLabel("条件 1 阈值（万元）", { exact: true }).fill("5");
  await page.getByRole("button", { name: /添加条件/ }).click();
  await page.getByLabel("条件 2 指标", { exact: true }).selectOption("changePct");
  await page.getByLabel("条件 2 比较", { exact: true }).selectOption("lte");
  await page.getByLabel("条件 2 阈值（%）", { exact: true }).fill("-3");
  await page.getByLabel("条件组合方式", { exact: true }).selectOption("any");
  await page.getByLabel("启用该股条件监控", { exact: true }).uncheck();
  await page.getByRole("button", { name: "保存条件", exact: true }).click();
  await page.waitForFunction(() => window.saveResult === true);
  const stored = await page.evaluate(() => window.monitors.configs["600000"]);
  assert.equal(stored.conditions[0].value, 50000);
  assert.equal(stored.conditions[1].value, -3);
  assert.equal(stored.mode, "any");
  assert.equal(stored.enabled, false);
  await page.reload();
  await page.getByLabel("条件 1 阈值（万元）", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("条件 1 阈值（万元）", { exact: true }).inputValue(), "5");
  assert.equal(await page.getByLabel("启用该股条件监控", { exact: true }).isChecked(), false);
  assert.equal(await page.getByLabel("条件组合方式", { exact: true }).inputValue(), "any");
}));

test("storage write failure keeps both the active configuration and the persisted threshold", async () => inPage(async page => {
  const threshold = page.getByLabel("条件 1 阈值（元）", { exact: true });
  await threshold.fill("10");
  await page.getByRole("button", { name: "保存条件", exact: true }).click();
  await page.waitForFunction(() => window.saveResult === true);
  await page.evaluate(() => { window.saveResult = null; Storage.prototype.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); }; });
  await threshold.fill("12");
  await page.getByRole("button", { name: "保存条件", exact: true }).click();
  await page.waitForFunction(() => window.saveResult === false);
  assert.equal(await page.evaluate(() => window.monitors.configs["600000"].conditions[0].value), 10);
  assert.match(await page.getByRole("alert").innerText(), /保存失败/);
  await page.reload();
  await threshold.waitFor();
  assert.equal(await threshold.inputValue(), "10");
}));

test("real hook refuses adapter zero placeholders before alerting on the next complete crossing", async () => inPage(async page => {
  await page.getByLabel("条件 1 指标", { exact: true }).selectOption("changePct");
  await page.getByLabel("条件 1 比较", { exact: true }).selectOption("lte");
  await page.getByLabel("条件 1 阈值（%）", { exact: true }).fill("0");
  await page.getByRole("button", { name: "保存条件", exact: true }).click();
  await page.waitForFunction(() => window.saveResult === true);
  await page.evaluate(() => {
    const setInterval = window.setInterval.bind(window);
    window.setInterval = (callback, delay, ...args) => { if (delay === 5000) { window.monitorTick = callback; return setInterval(callback, 3600000, ...args); } return setInterval(callback, delay, ...args); };
    window.changeLive(true);
  });
  await page.waitForFunction(() => window.monitors.runtimes["600000"]?.status === "baseline");
  await page.evaluate(() => { window.nextQuote = { ...window.nextQuote, changePct: 0, missingFields: ["changePct"] }; window.monitorTick(); });
  await page.waitForFunction(() => window.monitors.runtimes["600000"]?.status === "unavailable");
  assert.equal(await page.evaluate(() => window.monitors.alerts.length), 0);
  await page.evaluate(() => { window.nextQuote = { ...window.nextQuote, missingFields: [] }; window.monitorTick(); });
  await page.waitForFunction(() => window.monitors.alerts.length === 1);
  await page.evaluate(() => window.monitorTick());
  await page.waitForFunction(() => window.monitors.runtimes["600000"]?.status === "matched");
  assert.equal(await page.evaluate(() => window.monitors.alerts.length), 1);
}));
