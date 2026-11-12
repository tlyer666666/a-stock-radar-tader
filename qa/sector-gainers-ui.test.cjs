'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createPreview, openView, theme } = require('./frontend-v150.cjs');

const board = [
  { code: '881155', name: '银行', returns: { r1: -0.4 }, memberAverageReturn: -0.4, memberCount: 42 },
  { code: '881121', name: '半导体', returns: { r1: 3.68 }, memberAverageReturn: 3.68, memberCount: 142 },
  { code: '', name: '元件', returns: { r1: 0.8 }, memberAverageReturn: 0.8, memberCount: 63 },
  { code: 'THS:BJ', name: '北交所', boardType: 'exchange', displayCode: '京证A股 · 同花顺', state: '部分成分 · 涨幅待补',
    returns: { r1: null }, memberAverageReturn: null, memberCount: null,
    memberCoverage: { loaded: 1, total: null, complete: false }, warning: '同花顺北交所分类访问受限。当前只展示已取得的个股，不代表全市场。' }
];
const stocks = {
  半导体: [{ code: '688608', name: '恒玄科技', latest: 106.32, changePct: 20, mainNetInflow: 120000000 }, { code: '688981', name: '中芯国际', latest: 68.5, changePct: 3.4, mainNetInflow: null }],
  银行: [{ code: '601988', name: '中国银行', latest: 4.5, changePct: 0.14, mainNetInflow: 0 }],
  元件: [{ code: '831641', name: '格利尔', latest: 13.1, changePct: 2.1, mainNetInflow: -35000000 }],
  北交所: [{ code: '920096', name: '嘉晨智能', latest: 35.77, changePct: 29.98 }]
};

async function fixture(run) {
  const app = await createPreview();
  const page = await app.browser.newPage({ viewport: { width: 1480, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(app.url + '?populated=1');
    await page.locator('.workspace-navigation').waitFor();
    await theme(page, 'light');
    await page.evaluate(({ board, stocks }) => {
      window.__sectorCalls = [];
      window.__failSector = '';
      window.__slowSector = '';
      window.stockApi.getLimitUpSectorBoard = async () => board;
      window.stockApi.analyzeSector = async input => {
        window.__sectorCalls.push(input);
        const name = typeof input === 'string' ? input : input.name;
        if (window.__slowSector === name) await new Promise(resolve => setTimeout(resolve, 500));
        if (window.__failSector === name) throw new Error('行情暂不可用');
        const constituents = (stocks[name] || []).map(stock => ({ ...stock,
          fundFlowSource: '东方财富', fundFlowAsOf: '2026-10-20T07:26:00.000Z', fundFlowCheckedAt: '2026-10-20T07:27:00.000Z' }));
        return { ...board.find(row => row.name === name), constituents, leaders: [],
          fundFlow: { source: '东方财富', loaded: constituents.filter(stock => stock.mainNetInflow != null).length,
            total: constituents.length, asOf: '2026-10-20T07:26:00.000Z', checkedAt: '2026-10-20T07:27:00.000Z', cacheSeconds: 60 } };
      };
    }, { board, stocks });
    await openView(page, 'sectors', '板块强度');
    await page.getByRole('button', { name: '半导体，展开个股', exact: true }).waitFor();
    await run(page);
    assert.deepEqual(errors, [], 'renderer errors');
  } finally { await page.close(); await app.close(); }
}

test('gainers ranking sorts by returns; row expands its own stocks, filters, opens a stock and collapses', async () => fixture(async page => {
  assert.deepEqual(await page.locator('.sector-gainers-row[aria-expanded]').evaluateAll(rows => rows.map(row => row.getAttribute('aria-label'))), ['半导体，展开个股', '元件，展开个股', '银行，展开个股']);
  assert.equal(await page.locator('.sector-inline-detail').count(), 0, 'no blank stock table before click');
  await page.getByRole('button', { name: '半导体，展开个股', exact: true }).click();
  const region = page.getByRole('region', { name: '半导体 成分股', exact: true });
  await region.getByRole('button', { name: /恒玄科技/ }).waitFor();
  assert.match(await region.innerText(), /已加载 2 只 \/ 板块 142 只/);
  // B-09：板块榜改成原生 <table> 语义后，展开的明细是「展开行的兄弟 <tr>」，
  // 明细本身被 <tr><td id="sector-gainers-detail-N"> 包住 —— 于是
  //   · region.previousElementSibling 是 <td>（不是行），原来的邻接断言拿到 null；
  //   · region.closest('tr') 拿到的是明细行本身（无 aria-label），也不是展开行。
  // 邻接关系是布局细节，改用与嵌套层级无关的 ARIA 关联断言：
  //   1) 展开按钮用 aria-controls 指向明细容器；
  //   2) 明细区域确实位于该 id 的容器内；
  //   3) 含该按钮的那一行 aria-label 是「半导体，收起个股」（明细挂在它自己那一行上）。
  const toggle = page.getByRole('button', { name: '半导体，收起个股', exact: true });
  const controls = await toggle.getAttribute('aria-controls');
  assert.ok(controls, '展开按钮必须用 aria-controls 指向明细容器');
  assert.equal(await region.evaluate((element, id) => Boolean(element.closest('#' + id)), controls), true,
    `明细区域必须位于 aria-controls 指向的容器内（${controls}）`);
  assert.equal(await page.locator('tr', { has: toggle }).getAttribute('aria-label'), '半导体，收起个股');
  const bounds = await region.getByRole('button', { name: /恒玄科技/ }).boundingBox();
  assert.ok(bounds.y >= 0 && bounds.y + bounds.height < 960, JSON.stringify(bounds));
  const calls = await page.evaluate(() => window.__sectorCalls);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].code, '881121');
  await region.getByLabel('筛选当前板块个股').fill('中芯');
  assert.equal(await region.locator('.member-row:not(.member-head)').count(), 1);
  await region.getByLabel('筛选当前板块个股').fill('');
  await region.getByRole('button', { name: /恒玄科技/ }).click();
  await page.getByRole('button', { name: '返回板块强度', exact: true }).waitFor();
}));

test('member funds show provenance, missing-data text and neutral zero; refresh requests fresh data', async () => fixture(async page => {
  await page.getByRole('button', { name: '半导体，展开个股', exact: true }).click();
  let region = page.getByRole('region', { name: '半导体 成分股', exact: true });
  const source = region.locator('.sector-fund-flow-source');
  await source.waitFor();
  assert.match(await source.innerText(), /东方财富.*1\s*\/\s*2/);
  const first = region.locator('.member-row:not(.member-head)').first().locator('span').nth(5);
  assert.match(await first.innerText(), /\+1\.20\s*亿/);
  assert.match(await first.getAttribute('title'), /东方财富.*2026/);
  assert.equal(await region.locator('.member-row:not(.member-head)').nth(1).locator('span').nth(5).innerText(), '暂缺');
  await region.getByRole('button', { name: '刷新个股数据', exact: true }).click();
  await region.locator('.member-row:not(.member-head)').first().waitFor();
  assert.equal(await page.evaluate(() => window.__sectorCalls.at(-1).forceRefresh), true);
  await page.getByRole('button', { name: '银行，展开个股', exact: true }).click();
  region = page.getByRole('region', { name: '银行 成分股', exact: true });
  const zero = region.locator('.member-row:not(.member-head)').first().locator('span').nth(5);
  await zero.waitFor();
  assert.match(await zero.innerText(), /^0/);
  assert.doesNotMatch(await zero.getAttribute('class'), /red|green/);
}));

test('row loading and retry stay inline; switching and late responses never show the wrong stocks', async () => fixture(async page => {
  await page.evaluate(() => { window.__failSector = '元件'; });
  await page.getByRole('button', { name: '元件，展开个股', exact: true }).click();
  const region = page.getByRole('region', { name: '元件 成分股', exact: true });
  await region.getByRole('alert').waitFor();
  // 面向用户的说明 + 可展开的「技术详情」（原始错误）。
  assert.match(await region.innerText(), /暂未取得 元件 的板块行情/);
  assert.match(await region.evaluate(element => element.textContent), /行情暂不可用/);
  await page.evaluate(() => { window.__failSector = ''; });
  await region.getByRole('button', { name: '重试加载个股' }).click();
  await region.getByRole('button', { name: /格利尔/ }).waitFor();
  await page.getByRole('button', { name: '元件，收起个股', exact: true }).click();
  assert.equal(await page.locator('.sector-inline-detail').count(), 0);
  await page.evaluate(() => { window.__slowSector = '半导体'; });
  await page.getByRole('button', { name: '半导体，展开个股', exact: true }).click();
  await page.getByRole('status').filter({ hasText: '正在加载 半导体' }).waitFor();
  await page.getByRole('button', { name: '银行，展开个股', exact: true }).click();
  const bank = page.getByRole('region', { name: '银行 成分股', exact: true });
  await bank.getByRole('button', { name: /中国银行/ }).waitFor();
  await page.waitForTimeout(600);
  assert.doesNotMatch(await bank.innerText(), /恒玄科技/);
  assert.equal(await page.locator('.sector-inline-detail').count(), 1);
}));


test('sector strength excludes the Beijing shortcut and legacy ranking row; the dedicated sidebar remains usable', async () => fixture(async page => {
  assert.equal(await page.getByRole('button', { name: '北交所，展开个股', exact: true }).count(), 0);
  assert.equal(await page.locator('.sector-search-panel').getByRole('button', { name: '北交所', exact: true }).count(), 0);
  assert.equal(await page.evaluate(() => window.__sectorCalls.length), 0);
  const nav = page.locator('.workspace-navigation').getByRole('button', { name: '北交所', exact: true });
  await nav.click();
  await page.locator('.app-shell[data-workspace="beijing"]').waitFor();
  await page.getByRole('region', { name: '北交所 成分股', exact: true }).getByRole('button', { name: /嘉晨智能/ }).waitFor();
  assert.equal((await page.evaluate(() => window.__sectorCalls.at(-1))).code, 'THS:BJ');
}));


test('industry and concept viewport counts load before expansion and agree with the limit-up filter', async () => {
  const app = await createPreview();
  const page = await app.browser.newPage({ viewport: { width: 1480, height: 960 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.goto(app.url + '?populated=1');
    await page.locator('.workspace-navigation').waitFor();
    await page.evaluate(() => {
      const count = { limitUps: 2, limitUpStocks: [{ code: '600001', name: '甲' }, { code: '600002', name: '乙' }], memberCount: 3, countComplete: true };
      window.__countCalls = [];
      window.stockApi.getSectorStrengthBoard = async () => ({
        industries: [{ name: '测试行业', code: '881121', returns: { r1: 3 }, memberCount: 3, limitUps: null }],
        concepts: [{ name: '测试概念', code: '308977', conceptCid: '308977', indexCode: '885998', changePct: 3, memberCount: 3, limitUps: null }],
        themes: [], warnings: [], limitUpTotal: 2, conceptLimitUpSource: ''
      });
      window.stockApi.getSectorLimitUpCount = async input => { window.__countCalls.push(input); return count; };
      window.stockApi.analyzeSector = async input => ({ ...input, limitCount: count, limitUps: 2, leaders: [], constituents: [
        ...count.limitUpStocks.map(stock => ({ ...stock, isLimitUp: true, latest: 11, preClose: 10, changePct: 10 })),
        { code: '600003', name: '丙', isLimitUp: false, latest: 10, preClose: 10, changePct: 0 }
      ] });
    });
    await openView(page, 'sectors', '板块强度');
    for (const [kind, name] of [['industry', '测试行业'], ['concept', '测试概念']]) {
      if (kind === 'concept') await page.getByRole('tab', { name: /^概念/ }).click();
      const row = page.locator('.sector-gainers-row[aria-expanded]').filter({ hasText: name });
      await page.waitForFunction(name => [...document.querySelectorAll('.sector-gainers-row[aria-expanded]')].some(row => row.textContent.includes(name) && row.querySelector('.sector-limit-cell')?.textContent.includes('2 家')), name);
      assert.equal(await page.locator('.sector-inline-detail').count(), 0);
      await row.getByRole('button', { name: `${name}，展开个股`, exact: true }).click();
      const region = page.getByRole('region', { name: `${name} 成分股`, exact: true });
      await region.getByRole('button', { name: '涨停 2', exact: true }).click();
      assert.equal(await region.locator('.member-row:not(.member-head)').count(), 2);
      assert.match(await row.locator('.sector-limit-cell').innerText(), /2 家/);
      await row.getByRole('button', { name: `${name}，收起个股`, exact: true }).click();
    }
    assert.deepEqual(await page.evaluate(() => window.__countCalls.map(call => call.boardType)), ['industry', 'concept']);
    assert.deepEqual(errors, []);
  } finally { await page.close(); await app.close(); }
});

test('sorting by limit-ups includes concepts outside the first sixty and does not flood requests', async () => {
  const app = await createPreview();
  const page = await app.browser.newPage({ viewport: { width: 1480, height: 960 } });
  page.setDefaultTimeout(8000);
  try {
    await page.goto(app.url + '?populated=1');
    await page.locator('.workspace-navigation').waitFor();
    await page.evaluate(() => {
      window.__pendingCounts = 0; window.__peakCounts = 0;
      window.stockApi.getSectorStrengthBoard = async () => ({ industries: [], concepts: Array.from({ length: 75 }, (_, i) => ({
        name: `概念${i}`, code: String(300000 + i), conceptCid: String(300000 + i), indexCode: String(885000 + i), changePct: 75 - i, limitUps: null
      })), themes: [], warnings: [] });
      window.stockApi.getSectorLimitUpCount = async input => {
        window.__peakCounts = Math.max(window.__peakCounts, ++window.__pendingCounts);
        await new Promise(resolve => setTimeout(resolve, 15));
        window.__pendingCounts--;
        return { limitUps: input.name === '概念74' ? 12 : 1, limitUpStocks: [], countComplete: true, memberCount: 100 };
      };
    });
    await openView(page, 'sectors', '板块强度');
    await page.getByRole('button', { name: '按涨停从大到小排序', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.sector-gainers-row[aria-expanded]')?.getAttribute('aria-label') === '概念74，展开个股', null, { timeout: 8000 });
    assert.match(await page.locator('.sector-gainers-row[aria-expanded]').first().innerText(), /12 家/);
    assert.ok(await page.evaluate(() => window.__peakCounts <= 12), 'full sorting must not issue every board request at once');
  } finally { await page.close(); await app.close(); }
});

test('live THS ranking row opens actual stocks through the browser', { skip: process.env.THS_LIVE !== '1', timeout: 180000 }, async () => {
  const svc = require('../electron/services.cjs');
  const rows = await svc.getLimitUpSectorBoard({ forceRefresh: true });
  assert.ok(rows.length > 0);
  assert.ok(rows.every(row => row.code), 'official ranking must retain parsed codes');
  const app = await createPreview();
  const page = await app.browser.newPage({ viewport: { width: 1480, height: 960 } });
  const output = path.resolve(__dirname, '../artifacts/sector-gainers');
  await fs.mkdir(output, { recursive: true });
  const records = [];
  try {
    await page.exposeFunction('__realSectorDetail', input => svc.analyzeSector(input, {}));
    await page.goto(app.url + '?populated=1');
    await page.locator('.workspace-navigation').waitFor();
    await theme(page, 'light');
    await page.evaluate(rows => {
      window.stockApi.getLimitUpSectorBoard = async () => rows;
      window.stockApi.analyzeSector = input => window.__realSectorDetail(input);
    }, rows);
    await openView(page, 'sectors', '板块强度');
    const selected = [...rows].sort((a, b) => (b.returns?.r1 ?? b.memberAverageReturn) - (a.returns?.r1 ?? a.memberAverageReturn));
    for (const row of [selected[0], selected.find(item => item.name === '银行') || selected[1]].filter(Boolean)) {
      await page.getByRole('button', { name: `${row.name}，展开个股`, exact: true }).click();
      const region = page.getByRole('region', { name: `${row.name} 成分股`, exact: true });
      await region.locator('.member-row:not(.member-head)').first().waitFor({ timeout: 120000 });
      const first = await region.locator('.member-row:not(.member-head)').first().innerText();
      const count = await region.locator('.member-row:not(.member-head)').count();
      assert.ok(count > 0);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const stockBounds = await region.locator('.member-row:not(.member-head)').first().boundingBox();
      const tableBounds = await page.locator('.sector-gainers-panel .sector-comparison-table').boundingBox();
      assert.ok(stockBounds.y >= Math.max(0, tableBounds.y) && stockBounds.y + stockBounds.height <= Math.min(960, tableBounds.y + tableBounds.height), `stock must be visible within table: ${JSON.stringify({stockBounds,tableBounds})}`);
      records.push({ name: row.name, code: row.code, visibleRows: count, first });
      await page.screenshot({ path: path.join(output, `${row.code}-expanded.png`) });
    }
    await fs.writeFile(path.join(output, 'live-verification.json'), JSON.stringify({ observedAt: new Date().toISOString(), rankingRows: rows.length, records }, null, 2));
    console.log(JSON.stringify(records));
  } finally { await page.close(); await app.close(); }
});
