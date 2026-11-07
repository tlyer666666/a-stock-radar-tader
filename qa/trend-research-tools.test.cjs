'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
let browser, server, base;
const dataset = { schemaVersion: 1, sourceClass: 'real', source: 'user public history', universeMode: 'selected', calendar: ['2026-10-20'],
  benchmarkRows: [{ date: '2026-10-20', open: 10, high: 10, low: 10, close: 10, volume: 1, amount: 1 }],
  securities: [{ security: { code: '600001', name: 'fixture', secid: '1.600001' }, rawRows: [], adjustedRows: [], statusHistory: [] }] };
before(async () => {
  const { createServer } = await import('vite');
  const main = await fs.readFile(path.resolve(__dirname, '../src/main.tsx'), 'utf8');
  const styles = [...main.matchAll(/import\s+["']\.\/([^"']+\.css)["']/g)].map(match => `import '/src/${match[1]}';`).join('\n');
  const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
    import React from 'react'; import { createRoot } from 'react-dom/client'; import Tools from '/src/TrendResearchTools.tsx'; ${styles}
    window.calls=[]; window.cancelled=[]; window.stockApi={cancelServiceJob:async id=>{window.cancelled.push(id);return true;}};
    window.report={qualification:{status:'REAL_DIAGNOSTIC',returnSuperiorityVerified:true,limitations:['fixture limitation']},baseline:{sharedAccount:{metrics:{closed:2,censored:1,unresolved:3,pending:4,completeEquityEvidence:false}}},advanced:{sharedAccount:{metrics:{closed:5,censored:6,unresolved:7,pending:8,completeEquityEvidence:true}}}};
    const mode=new URLSearchParams(location.search).get('mode');
    if(mode!=='missing')window.stockApi.evaluateTrendResearch=async input=>{window.calls.push(input);if(mode==='pending')return new Promise(resolve=>window.resolveEvaluation=resolve);return window.report;};
    const root=createRoot(document.getElementById('root'));window.mountResearch=()=>root.render(React.createElement(React.StrictMode,null,React.createElement('div',{className:'terminal-shell',style:{padding:12}},React.createElement(Tools,{qualityConfig:window.quality}))));window.unmountResearch=()=>root.render(null);window.mountResearch();
  </script></body></html>`;
  server = await createServer({ plugins: [{ name: 'research-tools-fixture', configureServer(vite) {
    vite.middlewares.use(async (request, response, next) => {
      if (request.url?.split('?')[0] !== '/__research_tools__') return next();
      try { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(request.url, html)); }
      catch (error) { next(error); }
    });
  } }], server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}/__research_tools__`;
  browser = await require('playwright-core').chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function run(mode, body) {
  const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(5000);
  try { await page.goto(`${base}?mode=${mode}`); await page.locator('.trend-research-tools').waitFor(); await body(page); assert.deepEqual(errors, []); }
  finally { await page.close(); }
}
async function fill(page) {
  await page.getByLabel('研究数据集 JSON', { exact: true }).setInputFiles({ name: 'history.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(dataset)) });
  await page.getByText(/已导入 history.json/).waitFor();
  for (const [name, value] of [['研究起始日期','2026-10-01'],['研究截止日期','2026-10-21'],['开发 / 检验分界日期','2026-10-20']]) await page.getByLabel(name, { exact: true }).fill(value);
}
test('research tools stay collapsed and unknown until an explicit data import and run', () => run('ready', async page => {
  const panel = page.locator('.trend-research-tools'); assert.equal(await panel.getAttribute('open'), null);
  assert.equal(await page.evaluate(() => window.calls.length), 0);
  await panel.locator(':scope > summary').click();
  assert.match(await panel.innerText(), /尚未导入数据集.*未知/);
  await page.getByRole('button', { name: '运行研究复核', exact: true }).click();
  assert.match(await page.getByRole('alert').innerText(), /导入/);
  await fill(page);
  await page.getByRole('button', { name: '运行研究复核', exact: true }).click();
  await page.getByRole('heading', { name: /数据资格/ }).waitFor();
  assert.match(await page.locator('.trend-research-report').innerText(), /收益优越结论：未验证/);
  const cells = await page.locator('.trend-research-report tbody tr').first().locator('td').allTextContents();
  assert.deepEqual(cells, ['不完整','2','1','3','4']);
  const calls = await page.evaluate(() => window.calls);
  assert.equal(calls.length, 1); assert.equal(calls[0].dataset.source, 'user public history'); assert.equal(calls[0].advancedStrategyId, 'quality-v2');
  assert.equal(calls[0].advancedConfig.maxExtensionAtr, 2); assert.equal(calls[0].splitDate, '2026-10-20'); assert.ok(calls[0].requestId);
  const download = page.waitForEvent('download'); await page.getByRole('button', { name: '导出研究报告 JSON', exact: true }).click();
  const saved = await download; assert.match(saved.suggestedFilename(), /2026-10-01-2026-10-21.json$/);
  const report = JSON.parse(await fs.readFile(await saved.path(), 'utf8')); assert.equal(report.baseline.sharedAccount.metrics.unresolved, 3);
  for (const width of [1024,760]) { await page.setViewportSize({ width, height: 900 }); assert.ok(await page.evaluate(() => document.documentElement.scrollWidth-document.documentElement.clientWidth) <= 2); }
  await page.getByLabel('研究截止日期', { exact: true }).fill('2026-10-22'); assert.equal(await page.locator('.trend-research-report').count(), 0);
}));
test('cancel and unmount invalidate late responses, target owned jobs, and never poll', () => run('pending', async page => {
  await page.locator('.trend-research-tools > summary').click(); await fill(page);
  await page.getByRole('button', { name: '运行研究复核', exact: true }).click();
  await page.getByRole('button', { name: '取消研究评估', exact: true }).click();
  await page.evaluate(() => window.resolveEvaluation(window.report));
  assert.equal(await page.locator('.trend-research-report').count(), 0);
  assert.equal(await page.evaluate(() => window.cancelled[0] === window.calls[0].requestId), true);
  await page.getByRole('button', { name: '运行研究复核', exact: true }).click();
  await page.waitForFunction(() => window.calls.length===2);
  await page.evaluate(() => window.unmountResearch()); await page.waitForFunction(() => window.cancelled.length===2);
  await page.evaluate(() => { window.resolveEvaluation(window.report); window.mountResearch(); });
  await page.locator('.trend-research-tools').waitFor(); await page.locator('.trend-research-tools > summary').click();
  assert.equal(await page.locator('.trend-research-report').count(), 0); assert.match(await page.locator('.trend-research-tools').innerText(), /尚未导入/);
  assert.equal(await page.evaluate(() => window.calls.length), 2);
}));
test('changing current quality parameters invalidates a report and cancels a pending comparison', () => run('pending', async page => {
  await page.locator('.trend-research-tools > summary').click(); await fill(page);
  await page.getByRole('button', { name: '运行研究复核', exact: true }).click();
  await page.waitForFunction(() => window.calls.length === 1);
  await page.evaluate(() => { window.quality={maxExtensionAtr:2.5,minCloseLocation:0.65,maxVolumeRatio:3.5};window.mountResearch(); });
  await page.waitForFunction(() => window.cancelled.length === 1);
  await page.evaluate(() => window.resolveEvaluation(window.report));
  assert.equal(await page.locator('.trend-research-report').count(), 0);
  assert.match(await page.locator('.trend-research-tools').innerText(), /参数已变化/);
  await page.getByRole('button', { name: '运行研究复核', exact: true }).click();
  await page.waitForFunction(() => window.calls.length === 2);
  await page.evaluate(() => window.resolveEvaluation(window.report));
  await page.locator('.trend-research-report').waitFor();
  assert.equal(await page.evaluate(() => window.calls[1].advancedConfig.maxExtensionAtr), 2.5);
  await page.evaluate(() => { window.quality={maxExtensionAtr:2,minCloseLocation:0.7,maxVolumeRatio:3};window.mountResearch(); });
  await page.waitForFunction(() => !document.querySelector('.trend-research-report'));
}));
test('older runtime and malformed files fail closed without a demo result', () => run('missing', async page => {
  await page.locator('.trend-research-tools > summary').click();
  await page.getByLabel('研究数据集 JSON', { exact: true }).setInputFiles({ name: 'bad.json', mimeType: 'application/json', buffer: Buffer.from('window.scriptExecuted=true;') });
  assert.match(await page.getByRole('alert').innerText(), /JSON/); assert.equal(await page.evaluate(() => window.scriptExecuted), undefined);
  await fill(page); await page.getByRole('button', { name: '运行研究复核', exact: true }).click();
  assert.match(await page.getByRole('alert').innerText(), /不支持研究评估/); assert.equal(await page.locator('.trend-research-report').count(), 0);
}));
