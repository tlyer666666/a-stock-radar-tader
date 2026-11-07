'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
let server, browser, base;
const output = path.resolve(__dirname, '../artifacts/ui-remediation-20261019');
before(async () => {
  const { createServer } = await import('vite');
  server = await createServer({ server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' });
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}/qa/ui-remediation-harness.html`;
  browser = await require('playwright-core').chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true, ignoreDefaultArgs: ['--hide-scrollbars'] });
  await fs.mkdir(output, { recursive: true });
});
after(async () => { await browser?.close(); await server?.close(); });
async function fixture(query = '') {
  const page = await browser.newPage({ viewport: { width: 1480, height: 940 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + query); await page.getByRole('button', { name: '持仓股', exact: true }).waitFor();
  return { page, errors };
}
const nav = (page, name) => page.locator('.workspace-navigation').getByRole('button', { name, exact: true }).click();
// 趋势模型位于「策略选股」策略库中：先进入工作台，再打开第一个趋势模型。
const openTrend = async page => { await nav(page, '策略选股'); await page.locator('.strategy-library-item.trend').first().click(); await page.locator('.trend-screener').waitFor(); };
const openPattern = async page => { await nav(page, '策略选股'); await page.locator('.strategy-signal-tab-list > button').first().click(); };

test('dense pool defaults to all stocks and supports search, sorting, keyboard navigation, persistent columns and resize', async () => {
  const { page, errors } = await fixture();
  try {
    await nav(page, '涨停监控'); const grid = page.getByRole('grid'); await grid.waitFor();
    assert.equal(await grid.locator('[role="row"][aria-selected]').count(), 25);
    assert.equal(await page.getByRole('button', { name: /^(展开全部|收起列表)$/ }).count(), 0);
    assert.ok(await page.getByRole('textbox', { name: '筛选涨停池' }).isVisible());
    await page.getByRole('textbox', { name: '筛选涨停池' }).fill('UI样本024');
    assert.equal(await grid.locator('[role="row"][aria-selected]').count(), 1);
    await page.getByRole('button', { name: '清除涨停池筛选' }).click();
    assert.equal(await grid.locator('[role="row"][aria-selected]').count(), 25);
    await grid.getByRole('columnheader').filter({ hasText: '现价' }).getByRole('button').click();
    assert.match(await grid.locator('[role="row"][aria-selected]').first().innerText(), /600124/);
    // 行高 28px（--terminal-row-h）+ 1px 行分隔线。
    const poolRowHeight = await grid.locator('[role="row"][aria-selected]').first().evaluate(el => el.getBoundingClientRect().height);
    assert.ok(poolRowHeight >= 28 && poolRowHeight <= 29.5, `dense pool row height ${poolRowHeight}`);
    const seal = grid.getByRole('columnheader').filter({ hasText: '首封' });
    assert.equal(await seal.evaluate(el => getComputedStyle(el).textAlign), 'right');
    const resize = page.getByRole('separator', { name: '调整名称列宽' }); const start = await resize.boundingBox();
    await page.mouse.move(start.x + 3, start.y + 10); await page.mouse.down(); await page.mouse.move(start.x + 63, start.y + 10); await page.mouse.up();
    assert.equal(await resize.getAttribute('aria-valuenow'), '164');
    await resize.dblclick(); assert.equal(await resize.getAttribute('aria-valuenow'), '104');
    await page.getByText('列设置', { exact: true }).click();
    assert.notEqual(await page.locator('.limit-columns-panel').evaluate(el => getComputedStyle(el).boxShadow), 'none');
    await page.getByRole('group', { name: '列显示设置' }).getByLabel('成交额', { exact: true }).uncheck();
    await nav(page, '持仓股'); await nav(page, '涨停监控');
    assert.equal(await grid.getByRole('columnheader').filter({ hasText: '成交额' }).count(), 0);
    await grid.focus(); await grid.press('End');
    const selected = await grid.locator('[aria-selected="true"]').innerText(); assert.match(selected, /600100/);
    await grid.press('Enter'); await page.waitForFunction(() => window.fixtureCalls.some(call => call.kind === 'open' && call.code === '600100'));
    await page.locator('.analysis-back-btn').waitFor();
    await nav(page, '涨停监控'); await page.screenshot({ path: path.join(output, 'pool-light.png'), fullPage: true, animations: 'disabled' });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('default full limit pool keeps every row reachable with the mouse wheel and both scrollbars', async () => {
  const { page, errors } = await fixture();
  try {
    await nav(page, '涨停监控');
    await page.getByRole('grid').waitFor();
    const scroll = page.locator('.limit-grid-scroll');
    for (const viewport of [{ width: 1280, height: 720 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      await scroll.evaluate(async el => {
        el.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const geometry = await scroll.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const panel = el.closest('.compact-limit-pool').getBoundingClientRect();
        return { height: el.clientHeight, total: el.scrollHeight, bottom: rect.bottom, panelBottom: panel.bottom };
      });
      assert.ok(geometry.height < geometry.total, 'expanded rows must overflow the table scroll area');
      assert.ok(geometry.bottom <= geometry.panelBottom, 'the panel must not clip the scrollbar');
      await scroll.hover({ position: { x: 180, y: 65 } });
      await page.mouse.wheel(0, 2000);
      await page.waitForFunction(() => {
        const el = document.querySelector('.limit-grid-scroll');
        return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      }, undefined, { timeout: 3000 });
      const headerTop = await page.locator('.limit-analysis-head').evaluate(el => el.getBoundingClientRect().top);
      const scrollTop = (await scroll.boundingBox()).y;
      assert.ok(Math.abs(headerTop - scrollTop) <= 2, 'column headers must stay visible while scrolling');
      await page.mouse.wheel(400, 0);
      await page.waitForFunction(() => document.querySelector('.limit-grid-scroll').scrollLeft > 0, undefined, { timeout: 3000 });
      await scroll.evaluate(async el => {
        el.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      const bar = await scroll.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const gutter = el.offsetWidth - el.clientWidth - 2 * el.clientLeft || parseFloat(getComputedStyle(el, '::-webkit-scrollbar').width);
        const thumbHeight = el.clientHeight * el.clientHeight / el.scrollHeight;
        return { x: rect.right - el.clientLeft - gutter / 2, y: rect.top + el.clientTop + thumbHeight / 2, delta: el.clientHeight / 2, gutter };
      });
      assert.ok(bar.gutter > 0, 'a draggable vertical scrollbar must be available, including overlay scrollbars');
      await page.mouse.move(bar.x, bar.y); await page.mouse.down();
      await page.mouse.move(bar.x, bar.y + bar.delta, { steps: 8 }); await page.mouse.up();
      await page.waitForFunction(() => document.querySelector('.limit-grid-scroll').scrollTop > 0, undefined, { timeout: 3000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    }
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('holdings totals preserve precision and semantic tones with single-line actions', async () => {
  const { page, errors } = await fixture();
  try {
    await nav(page, '持仓股'); await page.getByText('2.43 万', { exact: true }).waitFor();
    const facts = page.locator('.holdings-summary-grid .fact');
    assert.match(await facts.filter({ hasText: '持仓市值' }).innerText(), /2.43 万/);
    assert.ok(await facts.filter({ hasText: '浮动盈亏' }).locator('b.down').count());
    assert.ok(await facts.filter({ hasText: '按昨收估算' }).locator('b.up').count());
    const actions = await page.locator('.holdings-row-actions').first().locator('button').evaluateAll(elements => elements.map(el => el.getBoundingClientRect().top));
    assert.equal(new Set(actions).size, 1);
    // D2-06：原断言写死「持仓行高 === 28px」。行情格现在多渲染一行
    // 「报价更新 <时间>」（CollectionViews 的行情/更新时间列），行高改为由内容撑开
    // （min-height: 54px，实测 81.5625px），28px 已不可能成立。
    // 这里改成语义断言，不再写死像素：
    //   1) 行高足以显示多行内容（>= 32px），而不是被压扁；
    //   2) 各列从左到右互不重叠；
    //   3) 单元格内容没有被裁切（scrollHeight/scrollWidth 不超出可视区）。
    const rowLayout = await page.locator('.holdings-table .tr:not(.th)').first().evaluate(row => {
      const cells = [...row.children].map(cell => {
        const rect = cell.getBoundingClientRect();
        return {
          left: Math.round(rect.left * 100) / 100,
          right: Math.round(rect.right * 100) / 100,
          clipped: cell.scrollHeight > cell.clientHeight + 1 || cell.scrollWidth > cell.clientWidth + 1
        };
      });
      return { height: Math.round(row.getBoundingClientRect().height * 100) / 100, cells };
    });
    assert.ok(rowLayout.height >= 32, `holding rows must stay readable instead of being collapsed: ${JSON.stringify(rowLayout)}`);
    assert.ok(rowLayout.cells.length >= 6, `holding rows must keep every column: ${JSON.stringify(rowLayout)}`);
    rowLayout.cells.forEach((cell, index) => {
      assert.equal(cell.clipped, false, `holding cell #${index} must not clip its content: ${JSON.stringify(rowLayout)}`);
      if (index > 0) assert.ok(cell.left >= rowLayout.cells[index - 1].right - 0.5, `holding cells #${index - 1}/#${index} must not overlap: ${JSON.stringify(rowLayout)}`);
    });
    const danger = await page.locator('.holdings-row-actions .danger').first().evaluate(el => getComputedStyle(el).color);
    assert.notEqual(danger, await page.locator('.holdings-row-actions button').first().evaluate(el => getComputedStyle(el).color));
    await page.screenshot({ path: path.join(output, 'holdings-light.png'), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '黑夜', exact: true }).click();
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.querySelector('.nav-item.active')).color === 'rgb(232, 237, 243)');
    await page.screenshot({ path: path.join(output, 'holdings-dark.png'), fullPage: true, animations: 'disabled' });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('theme, tab, focus, native table density and narrow layouts remain usable after page switches', async () => {
  const { page, errors } = await fixture();
  try {
    const selected = page.locator('.workspace-navigation .nav-item.active');
    assert.equal(await selected.evaluate(el => getComputedStyle(el, '::before').width), '2px');
    await openTrend(page);
    const activeFilter = page.getByRole('button', { name: /^有效信号/ }); await activeFilter.click();
    assert.equal(await activeFilter.getAttribute('aria-pressed'), 'true');
    const activeBackground = await activeFilter.evaluate(el => getComputedStyle(el).backgroundColor);
    assert.notEqual(activeBackground, await page.getByRole('button', { name: /^全部候选/ }).evaluate(el => getComputedStyle(el).backgroundColor));
    await nav(page, '观察池'); await page.locator('.watch-stock-table tbody tr').first().waitFor();
    const watchRowHeight = await page.locator('.watch-stock-table tbody tr').first().evaluate(el => el.getBoundingClientRect().height);
    assert.ok(watchRowHeight >= 28 && watchRowHeight <= 29.5, `watch row height ${watchRowHeight} (28px + 1px divider)`);
    await nav(page, '涨停监控'); const search = page.getByRole('textbox', { name: '筛选涨停池' }); await search.focus();
    assert.notEqual(await page.locator('.limit-pool-search').evaluate(el => getComputedStyle(el).boxShadow), 'none');
    const firstSeal = page.locator('.limit-analysis-row[aria-selected]').first().locator('[role="gridcell"]').nth(7);
    assert.equal(await firstSeal.evaluate(el => el.scrollWidth > el.clientWidth), false);
    await page.setViewportSize({ width: 1024, height: 768 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    assert.ok(await search.isVisible());
    await page.screenshot({ path: path.join(output, 'pool-1024-light.png'), animations: 'disabled' });
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('signals paginate and clamp a reduced result, and trend preferences flush on navigation', async () => {
  const { page, errors } = await fixture();
  try {
    await openTrend(page);
    const query = page.getByRole('textbox', { name: '搜索代码或名称' }); await query.waitFor();
    await query.fill('切页保留'); await nav(page, '持仓股');
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('a-stock-radar:trend-view-preferences:v1')).query), '切页保留');
    await nav(page, '策略选股'); assert.equal(await query.inputValue(), '切页保留', 'returning to 策略选股 reopens the same trend model with its query');
    await openPattern(page); const panel = page.getByRole('region', { name: '策略股票候选' }); await panel.waitFor();
    assert.equal(await panel.locator('tbody tr').count(), 20);
    // 1.5.5 起结果表为语义表格：名称/代码/命中依据三行堆叠。1.6.4x 起加了「日K走势」迷你图（约 75px）和合并的行情列
    // （现价+涨跌、时间与选股收盘、换手、成交额四行），行高由这两列决定：上限按四行文字 + 单元格内边距计，内容不得被裁切。
    const firstRow = await panel.locator('tbody tr').first().evaluate(el => ({ height: el.getBoundingClientRect().height,
      clipped: [...el.children].filter(cell => cell.scrollHeight > cell.clientHeight + 1).map(cell => cell.className || cell.innerText.slice(0, 20)) }));
    assert.ok(firstRow.height <= 112, `result rows stay compact ${JSON.stringify(firstRow)}`);
    assert.deepEqual(firstRow.clipped, [], 'no result cell clips its content');
    await panel.getByRole('button', { name: '下一页' }).click(); await panel.getByRole('button', { name: '下一页' }).click();
    assert.equal(await panel.locator('tbody tr').count(), 5);
    await page.evaluate(() => { window.fixtureSignalCount = 5; }); await page.getByRole('button', { name: '重新选股' }).click();
    await panel.getByText('共 5 只 · 每页 20 只 · 第 1 / 1 页', { exact: true }).waitFor();
    await page.evaluate(() => { window.fixtureSignalCount = 45; }); await page.getByRole('button', { name: '重新选股' }).click();
    await panel.getByText('共 45 只 · 每页 20 只 · 第 1 / 3 页', { exact: true }).waitFor();
    assert.equal(await panel.locator('tbody tr').count(), 20);
    await page.screenshot({ path: path.join(output, 'signals-light.png'), fullPage: true, animations: 'disabled' }); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

test('six-stock comparison retains MA20 and AVWAP without ellipses', async () => {
  const { page, errors } = await fixture('?compare=1');
  try {
    await nav(page, '多股同列'); await page.getByText('MA20 121.33', { exact: true }).first().waitFor();
    assert.equal(await page.getByText('MA20 121.33', { exact: true }).count(), 6);
    assert.equal(await page.getByText('AVWAP 120.22', { exact: true }).count(), 6);
    const clipped = await page.locator('.compare-essential-metric').evaluateAll(elements => elements.some(el => el.scrollWidth > el.clientWidth + 1 || getComputedStyle(el).textOverflow === 'ellipsis'));
    assert.equal(clipped, false);
    await page.screenshot({ path: path.join(output, 'compare-six-light.png'), fullPage: true, animations: 'disabled' }); assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
