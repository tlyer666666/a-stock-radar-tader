'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { chromium } = require('playwright-core');
let browser, server, base;
before(async () => {
  const { createServer } = await import('vite');
  server = await createServer({
    plugins: [{ name: 'qa-private-component-exports', enforce: 'pre', transform(code, id) {
      if (id.endsWith('/src/App.tsx')) return code + '\nexport { TrendChartPanel as AuditChart, SettingsView as AuditSettings };\n';
    } }],
    optimizeDeps: { entries: ['index.html', 'qa/stability-ui-harness.html'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error'
  });
  await server.listen();
  base = `http://127.0.0.1:${server.httpServer.address().port}/qa/stability-ui-harness.html`;
  browser = await chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function withPage(mode, run, virtualClock = false) {
  const page = await browser.newPage();
  try { if (virtualClock) await page.clock.install(); await page.goto(base + (mode ? `?mode=${mode}` : '')); await page.waitForFunction(() => Array.isArray(window.calls)); await run(page); }
  finally { await page.close(); }
}
test('changing compare selection keeps a remaining loading stock able to complete', async () => withPage('compare', async page => {
  await page.waitForFunction(() => window.calls.filter(x => x.kind === 'analyze').length === 2);
  await page.locator('.compare-selected-chips button').filter({ hasText: '乙银行' }).click();
  await page.evaluate(() => { for (const resolve of Object.values(window.pending)) resolve(); });
  await page.waitForTimeout(200);
  assert.match(await page.locator('.compare-matrix').innerText(), /12\.34/);
}));
test('failed favorite persistence keeps the existing item and reports the failure', async () => withPage('', async page => {
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.getByRole('button', { name: '自选板块', exact: true }).click();
  const item = page.locator('.favorite-card').filter({ hasText: '甲银行' });
  await item.locator('[title="移出自选"]').click();
  await page.waitForTimeout(200);
  assert.equal(await item.count(), 1);
  assert.match(await page.locator('body').innerText(), /自选.*保存失败|保存.*失败/);
  assert.deepEqual(errors, []);
}));
test('slow holdings quote completes instead of being invalidated at every poll', async () => withPage('', async page => {
  await page.getByRole('button', { name: '持仓股', exact: true }).click();
  await page.waitForTimeout(6500);
  assert.match(await page.locator('.holdings-summary-panel').innerText(), /已取得 2\/2 条有效报价/);
  assert.equal(await page.evaluate(() => window.calls.filter(x => x.kind === 'quote').length), 2);
}));
test('late holding security lookup merges against current holdings without resurrecting removals', async () => withPage('', async page => {
  await page.evaluate(() => {
    window.stockApi.search = q => new Promise(resolve => window.resolveHoldingSearch = () => resolve([{ code: q, secid: '1.' + q, name: '新增丙银行', assetType: 'stock' }]));
    window.stockApi.saveHoldings = async items => { window.calls.push({ kind: 'holdingsWrite', codes: items.map(x => x.code) }); return items; };
  });
  await page.getByRole('button', { name: '持仓股', exact: true }).click();
  await page.getByLabel('证券代码', { exact: true }).fill('600036');
  await page.getByLabel('持仓数量', { exact: true }).fill('100');
  await page.getByLabel('成本价', { exact: true }).fill('15');
  await page.getByRole('button', { name: '保存持仓', exact: true }).click();
  await page.waitForFunction(() => !!window.resolveHoldingSearch);
  await page.locator('.holdings-table .tr').filter({ hasText: '甲银行' }).getByRole('button', { name: '移除', exact: true }).click();
  await page.waitForFunction(() => window.calls.some(x => x.kind === 'holdingsWrite'));
  await page.evaluate(() => window.resolveHoldingSearch());
  await page.locator('.holdings-table .tr').filter({ hasText: '新增丙银行' }).waitFor();
  assert.equal(await page.locator('.holdings-table .tr').filter({ hasText: '甲银行' }).count(), 0);
  const writes = await page.evaluate(() => window.calls.filter(x => x.kind === 'holdingsWrite'));
  assert.deepEqual(writes.at(-1).codes, ['000001', '600036']);
}));
test('editing the backtest target cancels the pending lookup intent before it can run', async () => withPage('', async page => {
  await page.evaluate(() => {
    window.stockApi.getStrategyDefinitions = async () => [{ id: 'trend_test', name: '隔离测试策略' }];
    window.stockApi.search = q => new Promise(resolve => window['resolveSearch' + q] = () => resolve([{ code: q, secid: '1.' + q, name: '旧标的', assetType: 'stock' }]));
    window.stockApi.runBacktest = async security => { window.calls.push({ kind: 'runBacktest', security }); throw Error('隔离捕获'); };
  });
  await page.getByRole('button', { name: '回测中心', exact: true }).click();
  const input = page.getByPlaceholder('输入股票名称或6位代码，例如 贵州茅台 / 600519');
  await input.fill('600000'); await page.getByRole('button', { name: '从所选日期开始回测', exact: true }).click();
  await page.waitForFunction(() => !!window.resolveSearch600000);
  await input.fill('000001'); await page.evaluate(() => window.resolveSearch600000());
  await page.waitForTimeout(200);
  assert.equal(await input.inputValue(), '000001');
  assert.equal(await page.evaluate(() => window.calls.filter(x => x.kind === 'runBacktest').length), 0);
}));
test('changing a selected backtest target rejects the previous run result when it arrives', async () => withPage('', async page => {
  await page.evaluate(() => {
    window.stockApi.getStrategyDefinitions = async () => [{ id: 'trend_test', name: '隔离测试策略' }];
    window.stockApi.search = async q => [{ code: q, secid: '1.' + q, name: q === '600000' ? '旧回测标的' : '新回测标的', assetType: 'stock' }];
    window.stockApi.runBacktest = security => new Promise(resolve => { window.finishPreviousBacktest = () => resolve({ security, strategyEngine: 'verified-signal-v2', metrics: {}, rows: [], trades: [], equityCurve: [] }); });
  });
  await page.getByRole('button', { name: '回测中心', exact: true }).click();
  const input = page.getByPlaceholder('输入股票名称或6位代码，例如 贵州茅台 / 600519');
  await input.fill('600000'); await page.getByRole('button', { name: '从所选日期开始回测', exact: true }).click();
  await page.waitForFunction(() => !!window.finishPreviousBacktest);
  await input.fill('000001');
  await page.locator('.backtest-security-suggestions button').filter({ hasText: '新回测标的' }).click();
  await page.evaluate(() => window.finishPreviousBacktest());
  await page.waitForTimeout(200);
  assert.doesNotMatch(await page.locator('.backtest-result-panel').innerText(), /标的 旧回测标的/);
  assert.equal(await page.getByRole('button', { name: '从所选日期开始回测', exact: true }).isEnabled(), true);
}));
test('editing a backtest target without selecting a suggestion invalidates the previous run', async () => withPage('', async page => {
  await page.evaluate(() => {
    window.stockApi.getStrategyDefinitions = async () => [{ id: 'trend_test', name: '隔离测试策略' }];
    window.stockApi.search = async q => [{ code: q, secid: '1.' + q, name: q === '600000' ? '旧回测标的' : '新回测标的', assetType: 'stock' }];
    window.stockApi.runBacktest = security => new Promise(resolve => { window.finishPreviousBacktest = () => resolve({ security, strategyEngine: 'verified-signal-v2', metrics: {}, rows: [], trades: [], equityCurve: [] }); });
  });
  await page.getByRole('button', { name: '回测中心', exact: true }).click();
  const input = page.getByPlaceholder('输入股票名称或6位代码，例如 贵州茅台 / 600519');
  await input.fill('600000'); await page.getByRole('button', { name: '从所选日期开始回测', exact: true }).click();
  await page.waitForFunction(() => !!window.finishPreviousBacktest);
  await input.fill('000001');
  await page.evaluate(() => window.finishPreviousBacktest());
  await page.waitForTimeout(200);
  assert.equal(await input.inputValue(), '000001');
  assert.doesNotMatch(await page.locator('.backtest-result-panel').innerText(), /标的 旧回测标的/);
  assert.equal(await page.getByRole('button', { name: '从所选日期开始回测', exact: true }).isEnabled(), true);
}));
test('repeated favorite removal stays removed when persistence is delayed', async () => withPage('', async page => {
  await page.evaluate(() => { window.stockApi.saveWatchlist = items => new Promise(resolve => { window.calls.push({kind:'saveFavorite',items}); window.finishFavoriteSave = () => resolve(items); }); });
  await page.getByRole('button', {name:'自选板块',exact:true}).click();
  await page.locator('.favorite-card').filter({hasText:'甲银行'}).locator('[title="移出自选"]').evaluate(element => { element.click(); element.click(); });
  await page.waitForFunction(() => window.calls.filter(x=>x.kind==='saveFavorite').length===1);
  await page.evaluate(() => window.finishFavoriteSave());
  await page.waitForFunction(() => window.calls.filter(x=>x.kind==='saveFavorite').length===2);
  await page.evaluate(() => window.finishFavoriteSave());
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.favorite-card').filter({hasText:'甲银行'}).count(),0);
}));
test('saving holdings before startup load settles cannot overwrite stored holdings', async () => withPage('holdings-startup', async page => {
  await page.evaluate(() => {
    window.stockApi.search=async q=>[{code:q,name:'新增丙银行',secid:'1.'+q,assetType:'stock'}];
    window.stockApi.saveHoldings=async items=>{window.calls.push({kind:'holdingsWrite',items});return items;};
  });
  await page.getByRole('button',{name:'持仓股',exact:true}).click();
  await page.getByLabel('证券代码',{exact:true}).fill('600036');
  await page.getByLabel('持仓数量',{exact:true}).fill('100');
  await page.getByLabel('成本价',{exact:true}).fill('15');
  await page.getByRole('button',{name:'保存持仓',exact:true}).click();
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.kind==='holdingsWrite').length),0);
  await page.evaluate(()=>window.finishHoldingsLoad());
  await page.locator('.holdings-table .tr').filter({hasText:'甲银行'}).waitFor();
  await page.getByRole('button',{name:'保存持仓',exact:true}).click();
  await page.locator('.holdings-table .tr').filter({hasText:'新增丙银行'}).waitFor();
  assert.equal(await page.locator('.holdings-table .tr').filter({hasText:'甲银行'}).count(),1);
}));
test('unmounting holdings stops old workers from requesting the rest of the removed batch', async () => withPage('holdings-six', async page => {
  await page.evaluate(()=>{window.quoteResolvers=[];window.stockApi.getQuoteSnapshot=security=>new Promise(resolve=>{window.calls.push({kind:'quote',code:security.code});window.quoteResolvers.push(()=>resolve({security,quote:{latest:10}}));});});
  await page.getByRole('button',{name:'持仓股',exact:true}).click();
  await page.waitForFunction(()=>window.calls.filter(x=>x.kind==='quote').length===4);
  await page.getByRole('button',{name:'涨停趋势',exact:true}).click();
  await page.evaluate(()=>window.quoteResolvers.splice(0).forEach(resolve=>resolve()));
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.kind==='quote').length),4);
}));
test('removed comparison stocks are evicted and reselected stocks fetch a fresh result', async () => withPage('compare', async page => {
  await page.waitForFunction(()=>window.calls.filter(x=>x.kind==='analyze').length===2);
  await page.evaluate(()=>Object.values(window.pending).forEach(resolve=>resolve()));
  await page.waitForTimeout(150);
  await page.locator('.compare-selected-chips button').filter({hasText:'乙银行'}).click();
  await page.getByPlaceholder('输入名称/代码，或从候选池添加').fill('乙银行');
  await page.locator('.compare-candidate-list button').filter({hasText:'乙银行'}).click();
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.kind==='analyze'&&x.code==='000001').length),2);
  await page.evaluate(()=>window.pending['000001']());
  await page.waitForTimeout(100);
  assert.match(await page.locator('.compare-matrix').innerText(),/12\.34/);
}));

test('news polling retries transient failures with bounded backoff and displays recovery', async () => withPage('news-retry', async page => {
  await page.waitForFunction(() => window.calls.some(x => x.kind === 'news'));
  await page.clock.runFor(16000);
  assert.ok(await page.evaluate(() => window.calls.filter(x => x.kind === 'news').length >= 3));
  assert.match(await page.locator('body').innerText(), /恢复后的资讯/);
}, true));
test('slow minute chart responses can complete without overlapping polling requests', async () => withPage('chart-slow', async page => {
  await page.getByRole('button', {name:'1分钟',exact:true}).click();
  await page.clock.runFor(33000);
  assert.match(await page.locator('.chart-heading').innerText(), /分钟图新来源/);
  assert.equal(await page.evaluate(() => window.maxChartPending), 1);
}, true));
test('StrictMode settings save and connection test settle in the active mount', async () => withPage('settings-strict', async page => {
  await page.getByRole('button', {name:'保存设置',exact:true}).click();
  await page.waitForFunction(() => window.calls.some(x => x.kind === 'settingsSave'));
  await page.clock.runFor(100);
  assert.equal(await page.getByRole('button',{name:/正在保存|保存设置/}).first().isDisabled(), false);
  await page.getByRole('button',{name:'测试连接',exact:true}).click();
  await page.clock.runFor(100);
  assert.match(await page.locator('.test-result').innerText(), /连接测试完成/);
}, true));
test('an old holding edit is update-only and cannot reinsert a subsequently removed record', async () => withPage('', async page => {
  await page.evaluate(() => {
    window.stockApi.search = q => new Promise(resolve => window.finishHoldingEdit = () => resolve([{code:q,name:'甲银行',secid:'1.'+q,assetType:'stock'}]));
    window.stockApi.saveHoldings = async items => { window.calls.push({kind:'holdingsWrite',codes:items.map(x=>x.code)}); return items; };
  });
  await page.getByRole('button',{name:'持仓股',exact:true}).click();
  const item=page.locator('.holdings-table .tr').filter({hasText:'甲银行'});
  await item.getByRole('button',{name:'编辑',exact:true}).click();
  await page.getByLabel('持仓数量',{exact:true}).fill('200');
  await page.getByRole('button',{name:'保存持仓',exact:true}).click();
  await page.waitForFunction(()=>!!window.finishHoldingEdit);
  await item.getByRole('button',{name:'移除',exact:true}).click();
  await page.waitForFunction(()=>window.calls.some(x=>x.kind==='holdingsWrite'));
  await page.evaluate(()=>window.finishHoldingEdit());
  await page.waitForFunction(()=>window.calls.filter(x=>x.kind==='holdingsWrite').length===2);
  assert.equal(await item.count(),0);
  assert.deepEqual(await page.evaluate(()=>window.calls.filter(x=>x.kind==='holdingsWrite').at(-1).codes),['000001']);
}));

test('news backoff keeps retrying at its cap and returns to the normal cadence after recovery', async () => withPage('news-retry', async page => {
  await page.evaluate(()=>{window.newsFailUntil=8;});
  await page.clock.runFor(330000);
  const calls=await page.evaluate(()=>window.calls.filter(x=>x.kind==='news'));
  assert.ok(calls.length>=10,'retrying must continue beyond the capped failure count');
  const gaps=calls.slice(1).map((call,index)=>call.time-calls[index].time);
  assert.ok(gaps.slice(4,8).every(gap=>gap>=59000 && gap<=61000),'failure retry delay stays bounded at one minute');
  assert.ok(gaps[8]>=4900 && gaps[8]<=6100,'successful retry restores the normal refresh interval');
  assert.match(await page.locator('body').innerText(),/恢复后的资讯/);
},true));
test('changing chart frame starts the new request and an old completion cannot clear its pending lock', async () => withPage('chart-slow', async page => {
  await page.waitForFunction(()=>window.calls.some(x=>x.kind==='chart'));
  await page.evaluate(()=>{
    window.frameRequests=[];window.frameResolves={};
    window.stockApi.getChart=(security,frame)=>new Promise(resolve=>{
      window.frameRequests.push(frame);
      window.frameResolves[frame]=()=>resolve({rows:[{date:'2026-09-30',open:10,close:11,high:12,low:9,volume:1}],source:'frame-'+frame,adjustment:'前复权',visibleLimit:1});
    });
  });
  await page.getByRole('button',{name:'1分钟',exact:true}).click();
  await page.getByRole('button',{name:'5分钟',exact:true}).click();
  await page.evaluate(()=>window.frameResolves['1']());
  await page.clock.runFor(10000);
  assert.deepEqual(await page.evaluate(()=>window.frameRequests),['1','5']);
  await page.evaluate(()=>window.frameResolves['5']());
  await page.clock.runFor(100);
  assert.match(await page.locator('.chart-heading').innerText(),/frame-5/);
},true));
test('StrictMode reports a settings save rejection and allows retrying', async () => withPage('settings-strict', async page => {
  await page.evaluate(()=>{window.failSettingsSave=true;});
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.clock.runFor(100);
  const errors=await page.getByRole('alert').allTextContents();
  assert.ok(errors.length>0 && errors.every(error=>error.includes('隔离保存错误')));
  assert.equal(await page.getByRole('button',{name:'保存设置',exact:true}).isEnabled(),true);
  await page.evaluate(()=>{window.failSettingsSave=false;});
  await page.getByRole('button',{name:'保存设置',exact:true}).click();
  await page.clock.runFor(100);
  assert.equal(await page.getByRole('alert').count(),0);
  assert.equal(await page.getByRole('button',{name:'保存设置',exact:true}).isEnabled(),true);
},true));

async function openPortfolio(page) {
  await page.getByRole('button',{name:'回测中心',exact:true}).click();
  const open=page.getByRole('button',{name:'多股组合回测',exact:true});
  if(await open.isVisible()) await open.click();
  await page.getByRole('heading',{name:'策略回测中心',exact:true}).waitFor();
}
test('portfolio results completed on another page remain visible when returning', async () => withPage('portfolio', async page => {
  await openPortfolio(page);
  await page.getByRole('button',{name:'执行策略回测',exact:true}).click();
  await page.waitForFunction(()=>!!window.finishPortfolio);
  await page.getByRole('button',{name:'持仓股',exact:true}).click();
  await page.evaluate(()=>window.finishPortfolio());
  await openPortfolio(page);
  assert.equal(await page.locator('.pbt-results').count(),1);
  assert.match(await page.locator('.pbt-results').innerText(),/后台组合回测已完成/);
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.kind==='portfolioRun').length),1);
},true));
test('portfolio navigation preserves an unfinished job and its failure can be retried', async () => withPage('portfolio', async page => {
  await openPortfolio(page);
  await page.getByRole('button',{name:'执行策略回测',exact:true}).click();
  await page.waitForFunction(()=>!!window.finishPortfolio);
  await page.getByRole('button',{name:'持仓股',exact:true}).click();
  await openPortfolio(page);
  assert.equal(await page.locator('.pbt-running-state').count(),1);
  await page.getByRole('button',{name:'持仓股',exact:true}).click();
  await page.evaluate(()=>window.rejectPortfolio());
  await openPortfolio(page);
  assert.match(await page.locator('.pbt-error-state').innerText(),/离线组合回测失败/);
  await page.locator('.pbt-error-state').getByRole('button',{name:'重试',exact:true}).click();
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.kind==='portfolioRun').length),2);
  await page.evaluate(()=>window.finishPortfolio());
  await page.locator('.pbt-results').waitFor();
},true));
test('hidden portfolio view pauses pending search and resumes it on return', async () => withPage('portfolio', async page => {
  await openPortfolio(page);
  await page.getByPlaceholder('输入股票名称或6位代码添加').fill('乙银行');
  await page.getByRole('button',{name:'持仓股',exact:true}).click();
  await page.clock.runFor(1000);
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.kind==='portfolioSearch').length),0);
  await openPortfolio(page);
  assert.equal(await page.getByPlaceholder('输入股票名称或6位代码添加').inputValue(),'乙银行');
  await page.clock.runFor(300);
  assert.equal(await page.evaluate(()=>window.calls.filter(x=>x.kind==='portfolioSearch').length),1);
},true));


test('explicit portfolio cancel reaches backend, ignores late result and retries with a fresh ID', async () => withPage('portfolio', async page => {
  await openPortfolio(page);
  await page.getByRole('button',{name:'执行策略回测',exact:true}).click();
  await page.waitForFunction(()=>!!window.finishPortfolio);
  await page.getByRole('button',{name:'取消回测',exact:true}).click();
  const calls=await page.evaluate(()=>window.calls.filter(x=>['portfolioRun','cancelJob'].includes(x.kind)));
  assert.equal(calls.length,2);assert.ok(calls[0].requestId);assert.equal(calls[1].requestId,calls[0].requestId);
  await page.evaluate(()=>window.finishPortfolio());await page.clock.runFor(100);
  assert.equal(await page.locator('.pbt-results').count(),0);
  await page.getByRole('button',{name:'执行策略回测',exact:true}).click();
  const ids=await page.evaluate(()=>window.calls.filter(x=>x.kind==='portfolioRun').map(x=>x.requestId));
  assert.notEqual(ids[0],ids[1]);await page.evaluate(()=>window.finishPortfolio());await page.locator('.pbt-results').waitFor();
},true));
test('signal cancel and unmount cancel their exact request without publishing old results', async () => withPage('signals-cancel', async page => {
  await page.waitForFunction(()=>window.scanResolves.length===1);
  await page.getByRole('button',{name:'取消复核',exact:true}).click();
  await page.evaluate(()=>window.scanResolves[0]());await page.clock.runFor(100);
  assert.doesNotMatch(await page.locator('body').innerText(),/取消后不得显示的过期结果/);
  await page.getByRole('button',{name:'重新推演复核',exact:true}).click();
  await page.waitForFunction(()=>window.scanResolves.length===2);
  await page.evaluate(()=>window.unmountFixture());
  const calls=await page.evaluate(()=>window.calls.filter(x=>['scanRun','cancelJob'].includes(x.kind)));
  assert.deepEqual(calls.map(x=>x.kind),['scanRun','cancelJob','scanRun','cancelJob']);
  assert.equal(calls[0].requestId,calls[1].requestId);assert.equal(calls[2].requestId,calls[3].requestId);assert.notEqual(calls[0].requestId,calls[2].requestId);
},true));
