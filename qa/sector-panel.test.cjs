'use strict';
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const detail = { status: 'partial', entry: { id: 'x', code: 'x', name: '印制电路板', kind: 'classification', level: 3, path: ['电子', '元件', '印制电路板'], classification: '同花顺 F10 三级行业字段', sourceUrl: 'https://basic.10jqka.com.cn/300964/field.html' }, fetchedAt: '2026-09-30T01:00:00.000Z', asOf: null, reportDate: '2026-06-30', members: [{ code: '300964', name: '本川智能', secid: '0.300964', latest: null, changePercent: null, turnover: null, amount: null }], coverage: { loaded: 1, declared: 49, excluded: 0, invalid: 0, pagesLoaded: 1, pagesTotal: 1, complete: false, scope: '同行对比名单' }, metrics: null, sources: [], warnings: ['不是实时完整成分'], evidence: [], relatedTerms: [] };
describe('sector stock lookup with actual React and offline provider boundaries', () => {
  let browser, server, base;
  before(async () => {
    const { createServer } = await import('vite');
    const fixture = { ...detail, entry: { ...detail.entry, id: 'classification:pcb' } };
    const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"></head><body style="margin:0"><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import SectorExplorerPanel from '/src/SectorExplorerPanel.tsx';
      import '/src/workbench.css';
      window.calls=[]; window.fixture=${JSON.stringify(fixture)};
      window.stock={code:'300964',name:'本川智能',secid:'0.300964',assetType:'stock'};
      window.catalog={status:'ready',entries:[window.fixture.entry],fetchedAt:window.fixture.fetchedAt,asOf:null,sources:[],warnings:[],coverage:{...window.fixture.coverage,loaded:1,complete:true}};
      window.handlers={
        search:async()=>[window.stock],
        getSectorCatalog:async()=>window.catalog,
        getSectorDetail:async()=>window.fixture,
        getSectorClassifications:async()=>({...window.catalog,entries:[window.fixture.entry]})
      };
      window.stockApi=Object.fromEntries(Object.keys(window.handlers).map(name=>[name,async args=>{window.calls.push({name,args});return structuredClone(await window.handlers[name](args))}]));
      window.stockApi.cancelSectorRequest=async id=>{window.calls.push({name:'cancel',args:id});return {cancelled:true}};
      window.stockApi.openExternal=async()=>{};
      window.root=createRoot(document.getElementById('root'));
      window.mount=()=>window.root.render(React.createElement(React.StrictMode,null,React.createElement(SectorExplorerPanel,{onOpenStock(){}})));
      window.mount();
    </script></body></html>`;
    server = await createServer({
      plugins: [{ name: 'sector-component-fixture', configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== '/__sector_component__') return next();
          try { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(request.url, html)); }
          catch (error) { next(error); }
        });
      } }],
      server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error'
    });
    await server.listen();
    base = `http://127.0.0.1:${server.httpServer.address().port}/__sector_component__`;
    browser = await require('playwright-core').chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
  });
  after(async () => { await browser?.close(); await server?.close(); });
  async function pageTest(run) {
    const page = await browser.newPage({ viewport: { width: 1024, height: 900 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(3000);
    try { await page.goto(base); await page.locator('.sector-explorer-entry').first().waitFor(); await run(page); assert.deepEqual(errors, []); }
    finally { await page.close(); }
  }

  test('name lookup resolves a candidate with keyboard selection before querying its code', async () => pageTest(async page => {
    const input = page.getByRole('combobox', { name: '股票名称或代码' });
    await input.fill('本川');
    await page.getByRole('option', { name: /本川智能/ }).waitFor();
    await input.press('ArrowDown'); await input.press('Enter');
    await page.getByRole('button', { name: '查行业', exact: true }).click();
    await page.locator('.sector-explorer-detail h3').waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.filter(x => x.name === 'getSectorClassifications').map(x => x.args.code)), ['300964']);
    assert.equal(await input.inputValue(), '本川智能 300964');
  }));

  test('Chinese composition delays search and enter until composition ends', async () => pageTest(async page => {
    const input = page.getByRole('combobox', { name: '股票名称或代码' });
    await input.focus(); await input.dispatchEvent('compositionstart'); await input.fill('本川'); await input.press('Enter');
    await page.waitForTimeout(350);
    assert.equal(await page.evaluate(() => window.calls.filter(x => ['search', 'getSectorClassifications'].includes(x.name)).length), 0);
    await input.dispatchEvent('compositionend', { data: '本川' });
    await page.getByRole('option', { name: /本川智能/ }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.filter(x => x.name === 'search').map(x => x.args)), ['本川']);
  }));

  test('late search cannot replace a newer query or revive cleared results', async () => pageTest(async page => {
    await page.evaluate(() => { window.searchResolvers={}; window.handlers.search=q=>new Promise(resolve=>window.searchResolvers[q]=resolve); });
    const input = page.getByRole('combobox', { name: '股票名称或代码' });
    await input.fill('旧'); await page.waitForFunction(() => Boolean(window.searchResolvers['旧']));
    await input.fill('新'); await page.waitForFunction(() => Boolean(window.searchResolvers['新']));
    await page.evaluate(() => window.searchResolvers['新']([{...window.stock,name:'新名称'}]));
    await page.getByRole('option', { name: /新名称/ }).waitFor();
    await page.evaluate(() => window.searchResolvers['旧']([{...window.stock,name:'旧名称'}]));
    assert.equal(await page.getByRole('option', { name: /旧名称/ }).count(), 0);
    await input.fill('迟到'); await page.waitForFunction(() => Boolean(window.searchResolvers['迟到']));
    await page.getByRole('button', { name: '清空股票查询' }).click();
    await page.evaluate(() => window.searchResolvers['迟到']([window.stock]));
    assert.equal(await input.inputValue(), ''); assert.equal(await page.getByRole('option').count(), 0);
  }));

  test('search failures and empty matches stay distinct and editing invalidates a pending classification', async () => pageTest(async page => {
    await page.evaluate(() => { window.handlers.search=async()=>{throw new Error('离线搜索失败')}; });
    const input = page.getByRole('combobox', { name: '股票名称或代码' });
    await input.fill('失败'); await page.getByText('搜索失败：离线搜索失败', { exact: true }).waitFor();
    await page.evaluate(() => { window.handlers.search=async()=>[]; });
    await input.fill('无匹配'); await page.getByText('没有匹配的 A 股股票。', { exact: true }).waitFor();
    await page.evaluate(() => { window.handlers.getSectorClassifications=()=>new Promise(resolve=>window.finishClassifications=resolve); });
    await input.fill('300964'); await page.getByRole('button', { name: '查行业', exact: true }).click();
    await page.waitForFunction(() => Boolean(window.finishClassifications));
    await input.fill('别的股票');
    await page.evaluate(() => window.finishClassifications({...window.catalog,entries:[window.fixture.entry]}));
    await page.waitForTimeout(30);
    assert.equal(await page.locator('.sector-explorer-detail').count(), 0);
    assert.equal(await page.evaluate(() => window.calls.filter(x => x.name === 'getSectorDetail').length), 0);
  }));

  test('directory searches entries beyond the rendered page and omits manual research examples', async () => pageTest(async page => {
    await page.evaluate(() => {
      window.catalog.entries=Array.from({length:75},(_,i)=>({...window.fixture.entry,id:'entry-'+i,name:i===74?'尾页目标':'行业'+String(i).padStart(2,'0')}));
      window.catalog.entries.push({...window.fixture.entry,id:'research:legacy',name:'人工电子布样例',kind:'research'});
    });
    await page.getByRole('button', { name: '刷新目录', exact: true }).click();
    await page.getByLabel('搜索细分板块').fill('尾页目标');
    await page.locator('.sector-explorer-entry').filter({ hasText: '尾页目标' }).waitFor();
    await page.getByLabel('搜索细分板块').fill('');
    assert.equal(await page.getByRole('button', { name: '产业链研究', exact: true }).count(), 0);
    assert.equal(await page.getByText('人工电子布样例', { exact: true }).count(), 0);
    assert.equal(await page.locator('.sector-explorer-welcome p, .sector-explorer-welcome button, .sector-explorer-entry small, .sector-explorer-entry em').count(), 0);
  }));

  test('an empty classification tab offers stock lookup instead of an unexplained empty list', async () => pageTest(async page => {
    await page.evaluate(() => { window.catalog.entries=[{...window.fixture.entry,id:'industry:flat',name:'行业行情目录',kind:'industry',level:null,path:[]}]; });
    await page.getByRole('button', { name: '刷新目录', exact: true }).click();
    await page.getByRole('button', { name: '行业分类', exact: true }).click();
    await page.getByRole('button', { name: '输入股票名称查询行业分类', exact: true }).click();
    assert.equal(await page.getByRole('combobox', { name: '股票名称或代码' }).evaluate(e => e === document.activeElement), true);
  }));

  test('refreshing the public catalog retains discovered classification navigation and the selected detail', async () => pageTest(async page => {
    await page.evaluate(() => { window.catalog.entries=[{...window.fixture.entry,id:'industry:flat',name:'行业行情目录',kind:'industry',level:null,path:[]}]; window.catalog.coverage={...window.catalog.coverage,loaded:1,total:1,scope:'公开目录链接'}; });
    await page.getByRole('button', { name: '刷新目录', exact: true }).click();
    await page.locator('.sector-explorer-entry').filter({hasText:'行业行情目录'}).waitFor();
    await page.getByRole('combobox', { name: '股票名称或代码' }).fill('300964');
    await page.getByRole('button', { name: '查行业', exact: true }).click();
    await page.locator('.sector-explorer-detail h3').waitFor();
    await page.locator('.sector-explorer-catalog-sources summary').click();
    assert.match(await page.locator('.sector-explorer-catalog-coverage').innerText(), /公开目录链接.*已载入 1 \/ 1/);
    await page.getByRole('button', { name: '刷新目录', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.sector-explorer-actions button').disabled);
    assert.equal(await page.locator('.sector-explorer-entry').filter({hasText:'印制电路板'}).count(),1);
    assert.equal(await page.locator('.sector-explorer-detail h3').innerText(),'印制电路板');
    assert.match(await page.locator('.sector-explorer-catalog-coverage').innerText(), /公开目录链接.*已载入 1 \/ 1/);
    await page.getByLabel('搜索细分板块').fill('印制');
    await page.locator('.sector-explorer-entry').filter({hasText:'印制电路板'}).click();
    await page.locator('.sector-explorer-detail h3').waitFor();
  }));

  test('detail uses readable solid surfaces and compact status at narrow and wide sizes', async () => pageTest(async page => {
    await page.locator('.sector-explorer-entry').first().click(); await page.locator('.sector-explorer-detail h3').waitFor();
    for (const theme of ['dark', 'light']) for (const width of [760, 1024, 1480]) {
      await page.evaluate(theme => document.documentElement.dataset.theme=theme, theme); await page.setViewportSize({ width, height: 900 });
      const actual=await page.evaluate(()=>{
        const host=document.querySelector('.sector-explorer'), cell=host.querySelector('td'), header=host.querySelector('th'), status=host.querySelector('.sector-explorer-status');
        return {overflow:host.scrollWidth>host.clientWidth+2,font:parseFloat(getComputedStyle(cell).fontSize),header:parseFloat(getComputedStyle(header).fontSize),status:parseFloat(getComputedStyle(status).fontSize),background:getComputedStyle(host).backgroundColor};
      });
      assert.equal(actual.overflow,false,`${theme} ${width}`); assert.ok(actual.font>=14,JSON.stringify(actual)); assert.ok(actual.header>=14,JSON.stringify(actual)); assert.ok(actual.status>=14,JSON.stringify(actual)); assert.doesNotMatch(actual.background,/rgba\([^)]*,\s*0\)/);
    }
    assert.equal(await page.getByText('不是实时完整成分', { exact: true }).isVisible(), false);
    await page.locator('.sector-explorer-data-details summary').click();
    assert.equal(await page.getByText('不是实时完整成分', { exact: true }).isVisible(), true);
  }));
});
