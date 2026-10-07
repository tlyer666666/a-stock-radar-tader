"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { before, after, test } = require("node:test");

let browser;
let server;
let url;
const output = path.resolve(__dirname, "../artifacts/workflow-v145/preview");
before(async () => {
  const { createServer } = await import("vite");
  const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
    import React from 'react';
    import {createRoot} from 'react-dom/client';
    import {FavoritesView} from '/src/App.tsx';
    import useStockMonitors,{STOCK_MONITOR_STORAGE_KEY} from '/src/useStockMonitors.ts';
    import '/src/styles.css';import '/src/review.css';import '/src/terminal-research.css';import '/src/terminal-ui.css';import '/src/workbench.css';import '/src/watch-workspace.css';import '/src/stock-chart.css';
    const stocks=[{code:'600000',name:'合成监控甲',secid:'1.600000',thscode:'600000.SH',createdAt:new Date().toISOString(),favorite:true},{code:'000001',name:'合成监控乙',secid:'0.000001',thscode:'000001.SZ',createdAt:new Date().toISOString(),favorite:true}];
    localStorage.setItem(STOCK_MONITOR_STORAGE_KEY,JSON.stringify({configs:{'600000':{enabled:true,mode:'all',cooldownMinutes:5,conditions:[{id:'p',field:'latest',operator:'gte',value:10.8},{id:'c',field:'changePct',operator:'gte',value:3}]},'000001':{enabled:true,mode:'any',cooldownMinutes:10,conditions:[{id:'p',field:'changePct',operator:'lte',value:-4},{id:'t',field:'turnover',operator:'gte',value:8}]}},alerts:[]}));
    window.stockApi={getQuoteSnapshot:async stock=>({quote:{code:stock.code,latest:stock.code==='600000'?10.25:12.98,changePct:stock.code==='600000'?2.5:-1.2,turnover:2.8,amount:38000000,source:'qa-fixture'},actualProvider:'qa-fixture',updatedAt:new Date().toISOString()})};
    function Fixture(){const monitors=useStockMonitors({items:stocks,live:true,refreshSeconds:60});return React.createElement('div',{className:'app-shell terminal-shell'},React.createElement('div',{className:'window-dragbar'},'A股雷达 · 合成自选布局检查（非实时行情）'),React.createElement('aside',{className:'sidebar'},React.createElement('div',{className:'brand'},React.createElement('strong',null,'A股雷达')),React.createElement('nav',null,React.createElement('button',{className:'nav-item active'},'我的监控'))),React.createElement('main',{className:'main'},React.createElement('header',{className:'topbar'},React.createElement('span',null,'个股条件监控'),React.createElement('span',null,'离线预览')),React.createElement('div',{className:'page'},React.createElement(FavoritesView,{items:stocks,monitors,live:true,onOpen:()=>{},onRemove:()=>{}}))));}
    createRoot(document.getElementById('root')).render(React.createElement(Fixture));
  </script></body></html>`;
  server = await createServer({ plugins: [{ name: "personal-monitor-preview-fixture", configureServer(vite) { vite.middlewares.use(async (request, response, next) => { if (request.url !== "/__personal_monitor_preview__") return next(); try { response.setHeader("Content-Type", "text/html"); response.end(await vite.transformIndexHtml(request.url, html)); } catch (error) { next(error); } }); } }], server: { host: "127.0.0.1", port: 0, strictPort: false }, logLevel: "error" });
  await server.listen();
  url = `http://127.0.0.1:${server.httpServer.address().port}/__personal_monitor_preview__`;
  browser = await require("playwright-core").chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", headless: true });
  await fs.mkdir(output, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });

async function inspectPage(width, theme, run) {
  const page = await browser.newPage({ viewport: { width, height: 1050 }, colorScheme: theme });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.setDefaultTimeout(5000);
  try {
    await page.goto(url);
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await page.getByText("10.25", { exact: true }).waitFor();
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

async function assertNoHorizontalOverflow(page) {
  const overflowing = await page.evaluate(() => [...document.querySelectorAll('html,body,.main,.page,.personal-monitor-panel,.personal-monitor-card,.stock-monitor-editor,.stock-monitor-condition')].filter(node => node.scrollWidth > node.clientWidth + 1).map(node => ({ element: node.className || node.tagName, width: node.clientWidth, scrollWidth: node.scrollWidth })));
  assert.deepEqual(overflowing, []);
}

test("1480px light/dark monitor cards and expanded editor retain readable layout", async () => {
  for (const theme of ["light", "dark"]) await inspectPage(1480, theme, async page => {
    assert.equal(await page.locator(".personal-monitor-card").count(), 2);
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(output, `personal-monitor-${theme}-1480.png`) });
    await page.getByRole("button", { name: "编辑条件", exact: true }).first().click();
    await page.getByRole("heading", { name: /自定义监控/ }).waitFor();
    assert.equal(await page.getByLabel("条件 1 阈值（元）", { exact: true }).inputValue(), "10.8");
    await assertNoHorizontalOverflow(page);
    await page.screenshot({ path: path.join(output, `personal-monitor-editor-${theme}-1480.png`) });
  });
});

test("1280px expanded editor has no horizontal overflow and controls remain reachable", async () => inspectPage(1280, "light", async page => {
  await page.getByRole("button", { name: "编辑条件", exact: true }).first().click();
  await page.getByRole("heading", { name: /自定义监控/ }).waitFor();
  await page.getByRole("button", { name: /添加条件/ }).click();
  await page.getByLabel("条件 3 指标", { exact: true }).selectOption("amount");
  await page.getByLabel("条件 3 阈值（万元）", { exact: true }).fill("5000");
  await assertNoHorizontalOverflow(page);
  await page.getByRole("button", { name: "保存条件", exact: true }).scrollIntoViewIfNeeded();
  assert.equal(await page.getByRole("button", { name: "保存条件", exact: true }).isVisible(), true);
  await page.screenshot({ path: path.join(output, "personal-monitor-editor-light-1280.png") });
}));
