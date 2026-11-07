'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createPreview, geometry, theme } = require('./frontend-v150.cjs');
let app;
before(async () => { app = await createPreview(); });
after(async () => { await app?.close(); });

async function withPage(mode, run, width = 1480) {
  const page = await app.browser.newPage({ viewport: { width, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(10000);
  await page.route('**/*', route => /^https?:\/\/127\.0\.0\.1(?::\d+)?\//.test(route.request().url()) ? route.continue() : route.abort());
  try {
    await page.goto(app.url);
    await page.locator('.workspace-navigation').waitFor();
    await page.evaluate(mode => {
      window.__beijingQa = { calls: [], boardCalls: 0, analysis: [], mode };
      const originalAnalyze = window.stockApi.analyze.bind(window.stockApi);
      window.stockApi.analyze = async (...args) => { window.__beijingQa.analysis.push(args[0]); return originalAnalyze(...args); };
      window.stockApi.getLimitUpSectorBoard = async () => { window.__beijingQa.boardCalls += 1; return []; };
      window.stockApi.analyzeSector = async input => {
        const state = window.__beijingQa;
        state.calls.push(input);
        if (state.mode === 'error') throw new Error('北交所请求暂时失败');
        if (state.mode === 'pending') await new Promise(resolve => setTimeout(resolve, 400));
        return { name: '北交所', code: 'THS:BJ', boardType: 'exchange', memberCount: null,
          returns: { r1: null, r3: null, r5: null }, memberCoverage: { loaded: 2, total: null, complete: false },
          warning: '隔离界面样本：只显示已取得的个股，不代表北交所全市场。',
          constituents: [
            { code: '920096', name: '北交测试甲', secid: '0.920096', thscode: '920096.BJ', assetType: 'stock', latest: 20, changePct: 3 },
            { code: '920036', name: '北交测试乙', secid: '0.920036', thscode: '920036.BJ', assetType: 'stock', latest: 10, changePct: -2 }
          ] };
      };
    }, mode);
    await page.locator('.workspace-navigation').getByRole('button', { name: '北交所', exact: true }).click();
    await page.locator('.app-shell[data-workspace="beijing"]').waitFor();
    await run(page);
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
}

function members(page) { return page.getByRole('region', { name: '北交所 成分股', exact: true }); }

test('independent Beijing sidebar opens stocks directly, refreshes only Beijing data and returns from stock analysis', async () => withPage('success', async page => {
  const region = members(page);
  await region.getByRole('button', { name: /北交测试甲/ }).waitFor();
  assert.equal(await page.getByRole('heading', { name: '北交所', exact: true }).count(), 1);
  assert.equal(await page.locator('.sector-gainers-panel,.sector-search-panel').count(), 0);
  assert.equal(await page.locator('.workspace-navigation').getByRole('button', { name: '北交所', exact: true }).getAttribute('aria-current'), 'page');
  assert.match(await region.innerText(), /非全量/);
  assert.equal(await page.evaluate(() => window.__beijingQa.boardCalls), 0);
  const stock = region.getByRole('button', { name: /北交测试甲/ });
  await stock.click();
  await page.locator('.app-shell[data-workspace="dashboard"]').waitFor();
  await page.getByRole('button', { name: '返回北交所', exact: true }).click();
  await page.locator('.app-shell[data-workspace="beijing"]').waitFor();
  await region.getByRole('button', { name: /北交测试甲/ }).waitFor();
  assert.equal(await page.evaluate(() => window.__beijingQa.analysis.some(stock => stock.code === '920096')), true);
  await page.getByRole('button', { name: '刷新北交所行情', exact: true }).click();
  await region.getByRole('button', { name: /北交测试甲/ }).waitFor();
  assert.equal(await page.evaluate(() => window.__beijingQa.calls.at(-1).forceRefresh), true);
  await page.getByRole('textbox', { name: '筛选当前板块个股' }).fill('920036');
  assert.equal(await region.locator('.member-row:not(.member-head)').count(), 1);
  assert.match(await region.locator('.member-row:not(.member-head)').innerText(), /北交测试乙/);
  await page.getByRole('button', { name: '收起导航栏', exact: true }).click();
  const compactNav = page.locator('.workspace-navigation').getByRole('button', { name: '北交所', exact: true });
  assert.equal(await compactNav.getAttribute('aria-current'), 'page');
  assert.equal(await compactNav.isVisible(), true);
}));

test('Beijing error can retry directly and leaving during a pending response preserves the chosen workspace', async () => withPage('error', async page => {
  await members(page).getByRole('alert').waitFor();
  await page.evaluate(() => { window.__beijingQa.mode = 'success'; });
  await page.getByRole('button', { name: '重试加载个股', exact: true }).click();
  await members(page).getByRole('button', { name: /北交测试甲/ }).waitFor();
  assert.deepEqual(await page.evaluate(() => window.__beijingQa.calls.at(-1)), { name: '北交所', code: 'THS:BJ', forceRefresh: true, waitForQuotes: false });
  await page.evaluate(() => { window.__beijingQa.mode = 'pending'; });
  await page.getByRole('button', { name: '刷新北交所行情', exact: true }).click();
  await page.locator('.workspace-navigation').getByRole('button', { name: '观察池', exact: true }).click();
  await page.waitForTimeout(500);
  assert.equal(await page.locator('.app-shell').getAttribute('data-workspace'), 'watchlist');
  assert.equal(await page.getByRole('region', { name: '北交所 成分股', exact: true }).count(), 0);
}));

test('Beijing page keeps its sidebar, refresh control and stock names readable at 1024px in dark mode', async () => withPage('success', async page => {
  await members(page).getByRole('button', { name: /北交测试甲/ }).waitFor();
  await theme(page, 'dark');
  const measured = await geometry(page);
  assert.equal(measured.active, 'beijing');
  for (const root of measured.roots) assert.ok(root.scrollWidth <= root.width + 2, JSON.stringify(root));
  const refresh = await page.getByRole('button', { name: '刷新北交所行情', exact: true }).boundingBox();
  assert.ok(refresh.x >= 0 && refresh.x + refresh.width <= 1024 && refresh.y >= 0 && refresh.y + refresh.height <= 960);
  const output = path.resolve(__dirname, '../artifacts/beijing-workspace');
  await fs.mkdir(output, { recursive: true });
  await page.screenshot({ path: path.join(output, 'synthetic-1024-dark.png') });
}, 1024));

test('all 351 Beijing stocks stay searchable, including missing quotes and entries beyond the first page', async () => withPage('success', async page => {
  await page.evaluate(() => {
    window.stockApi.analyzeSector = async () => ({ name: '北交所', code: 'THS:BJ', boardType: 'exchange', memberCount: 351,
      memberCoverage: { loaded: 351, total: 351, complete: true }, quoteCoverage: { loaded: 350, total: 351, complete: false, pending: false, asOf: '2026-10-20' },
      warning: '同花顺行情350/351只；暂缺行情的股票仍保留在列表中。',
      constituents: Array.from({ length: 351 }, (_, index) => ({ code: String(920000 + index), name: '完整名录股' + index,
        latest: index === 350 ? null : 10, changePct: index === 350 ? null : index % 2 ? -1 : 1, quoteStatus: index === 350 ? 'unavailable' : 'ready' })) });
  });
  await page.getByRole('button', { name: '刷新北交所行情', exact: true }).click();
  const region = members(page);
  const rows = region.locator('.member-row:not(.member-head)');
  await rows.first().waitFor();
  // B-10：北交所不再一次挂 351 行（旧上限 1000），改成首屏 50 行 + 「加载更多」每次 +50。
  // 覆盖范围（全部 351 只都能看到、都能搜到）不变，只是到达方式变成翻页。
  assert.equal(await rows.count(), 50, '首屏只渲染第一页 50 行');
  assert.match(await region.locator('.panel-title').innerText(), /名单 351\/351/);
  const loadMore = region.locator('.member-load-more');
  await loadMore.waitFor();
  assert.match(await loadMore.innerText(), /还有 301 只，共 351 只/);
  let pages = 1;
  while (await loadMore.count()) {
    const rendered = await rows.count();
    const expected = Math.min(50 * (pages + 1), 351);
    await loadMore.click();
    pages += 1;
    await page.waitForFunction(target => document.querySelectorAll('.sector-members-panel .member-row:not(.member-head)').length >= target,
      Math.max(rendered + 1, expected));
    assert.ok(pages <= 8, `「加载更多」必须收敛，实际点了 ${pages} 次`);
  }
  assert.equal(await rows.count(), 351, '点满「加载更多」后全部 351 只都能渲染');
  await region.getByRole('button', { name: /完整名录股350/ }).waitFor({ state: 'attached' });
  assert.match(await region.locator('.panel-title').innerText(), /名单 351\/351/);
  // 搜索不受分页影响：筛选词变化会把分页重置回 50 行，但仍必须直接命中第 351 只（行情暂缺）。
  await page.getByRole('textbox', { name: '筛选当前板块个股' }).fill('920350');
  assert.equal(await rows.count(), 1);
  assert.match(await rows.innerText(), /行情暂缺/);
}));
