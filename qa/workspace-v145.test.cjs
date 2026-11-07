'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const tradingDates = ['2026-09-29', '2026-09-28', '2026-09-25', '2026-09-24', '2026-09-23', '2026-09-22', '2026-09-21', '2026-09-18', '2026-09-17', '2026-09-16'];
const watchItems = Array.from({ length: 398 }, (_, index) => ({
  code: String(600001 + index),
  name: index === 397 ? '末页目标股份' : `观察样本${String(index + 1).padStart(3, '0')}`,
  secid: `1.${600001 + index}`,
  thscode: `${600001 + index}.SH`,
  observationNode: `T+${index % 10 + 1}`,
  tradingDaysSince: index % 10 + 1,
  limitDate: tradingDates[index % 10],
  consecutiveBoards: index % 9 === 0 ? 2 : 1,
  createdAt: '2026-09-30T01:00:00.000Z'
}));
const boardRows = [7, 4, 4, 3, 3, 3, 2, 2, 2, 2, 2, 2].map((height, index) => ({
  code: String(601001 + index), name: `梯队样本${index + 1}`,
  consecutiveBoards: height, limitDate: '2026-09-30',
  firstSealRaw: 93000 + index * 100,
  firstSealTime: `09:${String(30 + index).padStart(2, '0')}:00`,
  openBoardCount: index % 3, turnover: index === 0 ? 10.25 : 2.3 + index,
  // 2026-11-06 实机：换手 10.25%、成交额 1860.78 万、封单/流通 11.80% 曾被截断或换行。
  latest: 15.8, changePct: 10.01, amount: index === 1 ? 18_607_800 : 441_000_000, sealFloatRatio: index === 2 ? 0.118 : 0.0892,
  sealedAmount: index === 3 ? 99_361_200 : 126_000_000, limitReason: '光伏+三季报增长+储能',
  industry: '合成行业'
}));

describe('v1.4.6 compact watch workspace and quick combinations in the actual renderer', () => {
  let browser, server, base;
  const screenshotDir = path.resolve(__dirname, '../artifacts/frontend-v150/watch-regression');

  before(async () => {
    const { createServer } = await import('vite');
    const mainSource = await fs.readFile(path.resolve(__dirname, '../src/main.tsx'), 'utf8');
    const cssImports = [...mainSource.matchAll(/^import "\.\/([^"\n]+\.css)";/gm)]
      .map(match => `import '/src/${match[1]}';`).join('\n');
    const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
      import React, { useState } from 'react';
      import { createRoot } from 'react-dom/client';
      import App, { WatchlistView } from '/src/App.tsx';
      import { Dashboard } from '/src/features/market/MarketWorkspace.tsx';
      ${cssImports}
      import { createPreviewApi } from '/src/previewApi.ts';
      window.callbacks = { opened: [], removed: [] };
      window.savedSettings = [];
      window.stockApi = createPreviewApi();
      const saveSettings = window.stockApi.saveSettings.bind(window.stockApi);
      window.stockApi.saveSettings = async value => {
        const saved = await saveSettings(value);
        window.savedSettings.push(structuredClone(saved));
        return saved;
      };
      function WatchHarness() {
        const [items, setItems] = useState(${JSON.stringify(watchItems)});
        const [activeNode, setActiveNode] = useState('all');
        return React.createElement('div', { className: 'app-shell terminal-shell', 'data-workspace': 'watchlist' },
          React.createElement('div', { className: 'window-dragbar' }, '观察池布局验证 · 合成测试数据'),
          React.createElement('aside', { className: 'sidebar' },
            React.createElement('strong', null, '工作台'),
            React.createElement('button', { className: 'nav-item active' }, '十日观察池')),
          React.createElement('main', { className: 'main' },
            React.createElement('header', { className: 'topbar' }, '398 条合成股票 · 仅验证界面交互'),
            React.createElement('div', { className: 'page' }, React.createElement(WatchlistView, {
              items, activeNode, onNodeChange: setActiveNode,
              onOpen(item) { window.callbacks.opened.push(item.code); },
              onRemove(item) { window.callbacks.removed.push(item.code); setItems(current => current.filter(row => row.code !== item.code)); }
            })),
            React.createElement('footer', { className: 'terminal-statusbar' }, '合成数据 · 浏览器交互检查')));
      }
      function PoolHarness() {
        return React.createElement('div', { className: 'app-shell terminal-shell', 'data-workspace': 'dashboard' },
          React.createElement('div', { className: 'window-dragbar' }, '涨停监控布局验证 · 合成测试数据'),
          React.createElement('aside', { className: 'sidebar' },
            React.createElement('strong', null, '工作台'),
            React.createElement('button', { className: 'nav-item active' }, '涨停监控')),
          React.createElement('main', { className: 'main' },
            React.createElement('header', { className: 'topbar' }, '12 只合成涨停股 · 仅验证界面布局'),
            React.createElement('div', { className: 'page' }, React.createElement(Dashboard, {
              mode: 'pool', payload: null, limitUps: ${JSON.stringify(boardRows)}, limitPoolMeta: null,
              onOpen(item) { window.callbacks.opened.push(item.code); }, onAdd() {}, onDiscover() {}
            })),
            React.createElement('footer', { className: 'terminal-statusbar' }, '合成数据 · 涨停监控布局检查')));
      }
      const mode = new URLSearchParams(location.search).get('mode');
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
        React.createElement(mode === 'app' ? App : mode === 'pool' ? PoolHarness : WatchHarness)));
    </script></body></html>`;
    server = await createServer({
      plugins: [{ name: 'workspace-v145-fixture', configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/__workspace_v145__') return next();
          try {
            response.setHeader('Content-Type', 'text/html');
            response.end(await vite.transformIndexHtml(request.url, html));
          } catch (error) { next(error); }
        });
      } }],
      server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error'
    });
    await server.listen();
    base = `http://127.0.0.1:${server.httpServer.address().port}/__workspace_v145__`;
    browser = await require('playwright-core').chromium.launch({
      executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true
    });
    await fs.mkdir(screenshotDir, { recursive: true });
  });

  after(async () => { await browser?.close(); await server?.close(); });

  async function pageTest(run, mode = 'watch') {
    const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5000);
    try {
      await page.goto(`${base}?mode=${mode}`);
      await page.locator(mode === 'watch' ? '.watch-stock-table tbody tr' : mode === 'pool' ? '.board-ladder-level' : '.workspace-navigation').first().waitFor();
      await run(page);
      assert.deepEqual(errors, [], 'the real renderer must not throw during interaction');
    } finally { await page.close(); }
  }

  test('398 stocks render as one scrollable list without pagination', async () => pageTest(async page => {
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 398);
    assert.equal(await page.locator('.watch-pagination').count(), 0);
    assert.equal(await page.getByRole('button', { name: /观察池[上下]一页/ }).count(), 0);
    assert.match(await page.locator('.watch-stock-table tbody tr').first().innerText(), /600001/);
    const lastRow = page.locator('.watch-stock-table tbody tr').last();
    assert.match(await lastRow.innerText(), /600398/);
    assert.equal((await lastRow.locator('td').first().innerText()).trim(), '398');
    const scroll = page.locator('.watch-table-scroll');
    await scroll.hover({ position: { x: 180, y: 65 } });
    await page.mouse.wheel(0, 100000);
    await page.waitForFunction(() => {
      const el = document.querySelector('.watch-table-scroll');
      return el.scrollTop > 0 && el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
    });
    const last = await lastRow.boundingBox(), area = await scroll.boundingBox();
    assert.ok(last.y >= area.y && last.y + last.height <= area.y + area.height + 1);
  }));

  test('every trading-day tab shows its complete list and resets scrolling', async () => pageTest(async page => {
    await page.locator('.watch-table-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    for (let day = 1; day <= 10; day++) {
      const count = day <= 8 ? 40 : 39;
      const tab = page.getByRole('group', { name: '观察交易日' }).getByRole('button', { name: new RegExp(`^T\\+${day}\\s*${count}$`) });
      await tab.click();
      await page.waitForFunction(node => [...document.querySelectorAll('.watch-day-badge')].every(badge => badge.textContent === node), `T+${day}`);
      assert.equal(await tab.getAttribute('aria-pressed'), 'true');
      assert.equal(await tab.locator('b').innerText(), String(count));
      assert.equal(await page.locator('.watch-stock-table tbody tr').count(), count);
      assert.deepEqual(await page.locator('.watch-day-badge').allTextContents(), Array(count).fill(`T+${day}`));
      assert.equal(await page.locator('.watch-table-scroll').evaluate(el => el.scrollTop), 0);
      assert.match(await page.locator('.watch-stock-table tbody tr').first().innerText(), new RegExp(String(600000 + day)));
      await page.locator('.watch-table-scroll').evaluate(el => { el.scrollTop = el.scrollHeight; });
    }
  }));

  test('name and code filters find any stock, and clearing restores the complete list', async () => pageTest(async page => {
    const input = page.getByRole('textbox', { name: '筛选观察池股票名称或代码' });
    await input.fill('末页目标');
    await page.waitForFunction(() => document.querySelectorAll('.watch-stock-table tbody tr').length === 1);
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 1);
    assert.match(await page.locator('.watch-stock-table tbody tr').innerText(), /末页目标股份[\s\S]*600398/);
    await input.fill('600398');
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 1);
    await input.fill('不存在的股票');
    await page.getByRole('heading', { name: '没有匹配的股票' }).waitFor();
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 0);
    await page.getByRole('button', { name: '清空观察池筛选' }).click();
    await page.waitForFunction(() => document.querySelectorAll('.watch-stock-table tbody tr').length === 398);
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 398);
  }));

  test('stock opening, row analysis and removing dispatch only their intended callback (ladder moved to the limit-up monitor)', async () => pageTest(async page => {
    await page.locator('.watch-stock-open').first().click();
    await page.getByRole('button', { name: '分析观察样本002', exact: true }).click();
    await page.getByRole('button', { name: '移出观察池观察样本003', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.watch-stock-table tbody tr').length === 397);
    assert.equal(await page.locator('.watch-stock-open').filter({ hasText: '观察样本003' }).count(), 0);
    assert.equal(await page.locator('.board-ladder').count(), 0, '连板梯队已移到涨停监控');
    assert.deepEqual(await page.evaluate(() => window.callbacks), {
      opened: ['600001', '600002'], removed: ['600003']
    });
  }));

  test('compact desktop density and stacked narrow layout preserve readable rows without page overflow', async () => pageTest(async page => {
    for (const theme of ['dark', 'light']) for (const width of [1280, 1480, 1920, 1024]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.setViewportSize({ width, height: 960 });
      await page.locator('.main > .page').evaluate(element => { element.scrollTop = 0; });
      const layout = await page.evaluate(() => {
        const bounds = selector => document.querySelector(selector).getBoundingClientRect();
        const page = document.querySelector('.main > .page');
        const workspace = document.querySelector('.ten-day-workspace');
        const list = bounds('.watch-stock-panel');
        const rowBounds = [...document.querySelectorAll('.watch-stock-table tbody tr')].map(row => row.getBoundingClientRect());
        const tableBounds = bounds('.watch-table-scroll');
        const tableHeaderBounds = bounds('.watch-stock-table thead');
        return {
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          pageOverflow: page.scrollWidth - page.clientWidth,
          workspaceOverflow: workspace.scrollWidth - workspace.clientWidth,
          listWidth: list.width, workspaceWidth: workspace.clientWidth, listBottom: list.bottom,
          tableBottom: tableBounds.bottom, viewportHeight: window.innerHeight,
          statusbarTop: bounds('.terminal-statusbar').top,
          firstRowTop: rowBounds[0].top, rowHeight: rowBounds[0].height,
          visibleRowCount: rowBounds.filter(row => row.top >= tableHeaderBounds.bottom - 1 && row.bottom <= tableBounds.bottom + 1).length,
          tabHeight: bounds('.watch-node-tabs button').height,
          visibleRows: document.querySelectorAll('.watch-stock-table tbody tr').length
        };
      });
      const context = `${theme} ${width}: ${JSON.stringify(layout)}`;
      assert.ok(layout.documentOverflow <= 2 && layout.pageOverflow <= 2 && layout.workspaceOverflow <= 2, context);
      assert.ok(layout.rowHeight >= 28 && layout.rowHeight <= 40, context);
      assert.ok(layout.tabHeight <= 42, context);
      assert.ok(layout.firstRowTop < 280, context);
      assert.ok(layout.visibleRowCount >= 15, context);
      // 观察池整行留给观察表（连板梯队在涨停监控）。
      assert.ok(layout.listWidth >= layout.workspaceWidth - 4, context);
      if (width >= 1280) assert.ok(layout.tableBottom <= layout.statusbarTop, context);
      assert.equal(layout.visibleRows, 398, context);
      await page.screenshot({ path: path.join(screenshotDir, `watch-workspace-${theme}-${width}.png`), animations: 'disabled' });
    }
  }));

  test('limit-up monitor shows the consecutive-board ladder beside the pool and opens stocks from it', async () => pageTest(async page => {
    assert.deepEqual(await page.locator('.board-ladder-level').evaluateAll(rows => rows.map(row => row.dataset.boardHeight)), ['7', '4', '3', '2']);
    // 涨停生态各块名称在页面最上方一字排开，默认收起；点开显示该块，再点收起。
    const tabs = page.getByRole('tablist', { name: '涨停生态分区' }).getByRole('tab');
    await tabs.first().waitFor();
    const names = await tabs.evaluateAll(items => items.map(item => item.querySelector('span').textContent));
    assert.ok(names.includes('连板天梯') && names.includes('涨停原因') && names.includes('龙虎榜'), names.join(','));
    const tops = await tabs.evaluateAll(items => items.map(item => Math.round(item.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 1, `tab names sit in one row at 1480px: ${tops}`);
    assert.ok((await page.locator('.fy-tabbar').boundingBox()).y < (await page.locator('.compact-limit-pool').boundingBox()).y, 'the names sit above the pool');
    assert.equal(await page.locator('.fy-tabpanel').count(), 0);
    await page.getByRole('tab', { name: /涨停原因/ }).click();
    await page.locator('.fy-tabpanel .fy-reasons').waitFor();
    assert.equal(await page.getByRole('tab', { name: /涨停原因/ }).getAttribute('aria-selected'), 'true');
    await page.getByRole('tab', { name: /龙虎榜/ }).click();
    await page.locator('.fy-tabpanel .fy-table').waitFor();
    assert.equal(await page.locator('.fy-tabpanel .fy-reasons').count(), 0, 'only one block is open at a time');
    await page.screenshot({ path: path.join(screenshotDir, 'limit-pool-ecology-tab-open.png'), animations: 'disabled' });
    await page.getByRole('tab', { name: /龙虎榜/ }).click();
    await page.waitForFunction(() => !document.querySelector('.fy-tabpanel'));
    await page.locator('.board-ladder-stock[data-code="601001"]').click();
    assert.deepEqual(await page.evaluate(() => window.callbacks.opened), ['601001']);
    // 和实机一样打开可选的「封单额」「涨停原因」两列再检查排版。
    await page.locator('.limit-columns-settings summary').click();
    for (const label of ['封单额', '涨停原因']) {
      const box = page.locator('.limit-columns-panel label', { hasText: label }).locator('input');
      if (!(await box.isChecked())) await box.check();
    }
    await page.locator('.limit-columns-settings summary').click();
    // 涨停原因、板块单行显示，不折行被截。
    const reasonCell = page.locator('.compact-limit-pool .limit-analysis-row:not(.limit-analysis-head) > div[title="光伏+三季报增长+储能"]').first();
    assert.ok((await reasonCell.boundingBox()).height <= 30, 'limit reason stays on one line');
    for (const theme of ['dark', 'light']) for (const width of [1920, 1480, 1280, 1024]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.setViewportSize({ width, height: 960 });
      await page.locator('.main > .page').evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
      const layout = await page.evaluate(() => {
        const bounds = selector => document.querySelector(selector).getBoundingClientRect();
        const pool = bounds('.compact-limit-pool'), ladder = bounds('.limit-ladder-sidebar');
        return {
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          poolWidth: pool.width, ladderWidth: ladder.width, poolTop: pool.top, ladderTop: ladder.top,
          poolRight: pool.right, ladderLeft: ladder.left, poolBottom: pool.bottom, ladderHeight: ladder.height,
          clippedLadderCards: [...document.querySelectorAll('.board-ladder-stock')].filter(card => card.getBoundingClientRect().right > ladder.right + 1).length
        };
      });
      const context = `${theme} ${width}: ${JSON.stringify(layout)}`;
      assert.ok(layout.documentOverflow <= 2, context);
      assert.ok(layout.ladderHeight >= 200, context);
      if (width > 1150) {
        assert.ok(layout.poolWidth > layout.ladderWidth * 2, context);
        assert.ok(Math.abs(layout.poolTop - layout.ladderTop) <= 2 && layout.ladderLeft >= layout.poolRight, context);
      } else {
        assert.ok(layout.ladderTop >= layout.poolBottom, context);
        assert.ok(Math.abs(layout.poolWidth - layout.ladderWidth) <= 2, context);
      }
      assert.equal(layout.clippedLadderCards, 0, context);
      // 数字列不截断、不换行（表格太窄时整表横向滚动，而不是把数字挤成「10.2…」）。
      const squeezed = await page.evaluate(() => [...document.querySelectorAll('.compact-limit-pool .limit-analysis-row:not(.limit-analysis-head) > .num')]
        .filter(cell => /^[-+]?[\d.,]+\s*(%|万|亿)?$|^\d{2}:\d{2}(:\d{2})?$/.test(cell.textContent.trim()))
        .filter(cell => cell.scrollWidth > cell.clientWidth + 1 || cell.getBoundingClientRect().height > 30).map(cell => cell.textContent));
      assert.deepEqual(squeezed, [], `${context} squeezed numeric cells`);
      // 每行单行显示：名称、质量等文字不折行（折行时行高参差、第二行被截）。
      const tallRows = await page.evaluate(() => [...document.querySelectorAll('.compact-limit-pool .limit-analysis-row:not(.limit-analysis-head)')]
        .filter(row => row.getBoundingClientRect().height > 34).map(row => row.textContent.slice(0, 24)));
      assert.deepEqual(tallRows, [], `${context} rows stay single-line`);
      const clippedText = await page.evaluate(() => [...document.querySelectorAll('.compact-limit-pool .limit-analysis-row:not(.limit-analysis-head) > div[title]')]
        .filter(cell => !/光伏|合成行业/.test(cell.title))
        .filter(cell => { const target = cell.querySelector('button') || cell; return target.scrollWidth > target.clientWidth + 1; }).map(cell => cell.title));
      assert.deepEqual(clippedText, [], `${context} names and quality labels fit`);
      // 「操作」列固定在右侧，表格横向滚动时仍完整可见。
      const actions = await page.evaluate(() => {
        const scroller = document.querySelector('.compact-limit-pool .limit-grid-scroll'), cell = document.querySelector('.compact-limit-pool .limit-row-actions');
        scroller.scrollLeft = 0;
        const before = cell.getBoundingClientRect().right <= scroller.getBoundingClientRect().right + 1;
        scroller.scrollLeft = scroller.scrollWidth;
        const after = cell.getBoundingClientRect().right <= scroller.getBoundingClientRect().right + 1;
        scroller.scrollLeft = 0;
        return { before, after };
      });
      assert.deepEqual(actions, { before: true, after: true }, `${context} actions column stays visible`);
      await page.screenshot({ path: path.join(screenshotDir, `limit-pool-ladder-${theme}-${width}.png`), animations: 'disabled' });
    }
  }, 'pool'));

  test('analysis presets persist in settings while signal selection uses its own rule catalog', async () => pageTest(async page => {
    await page.getByRole('button', { name: '数据源设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '策略组合', exact: true }).click();
    await page.locator('.strategy-presets').waitFor();
    assert.equal(await page.locator('.strategy-presets > button').count(), 16, 'fifteen presets plus all factors');

    // 产品调整：快捷策略组合不再挂在全局顶栏（会出现在所有板块上方），
    // 只保留在「策略选股」模块内。因此设置页不再有 .strategy-quick-trigger。
    assert.equal(await page.locator('.strategy-quick-trigger').count(), 0,
      '设置页不应出现快捷策略组合（已收归策略模块）');

    // 先在设置页完成「保存策略组合」的持久化验证
    await page.locator('.strategy-presets').getByRole('button', { name: /首板观察节点/ }).click();
    await page.getByRole('button', { name: '保存策略组合', exact: true }).click();
    await page.waitForFunction(() => window.savedSettings.length === 1);
    assert.deepEqual(await page.evaluate(() => window.savedSettings[0].selectedStrategies),
      ['firstBoardQuality', 'lowFirstBoard', 'exactNode', 'avwap', 'support', 'riskVeto']);

    // 选股页只使用既定信号策略目录；分析因子组合仍在设置页保存。
    await page.getByRole('button', { name: '策略选股', exact: true }).click();
    await page.locator('.strategy-signal-tab-list > button').first().waitFor();
    assert.equal(await page.locator('.strategy-quick-trigger').count(), 0);
    // 默认隐藏本轮无结果的策略；取消隐藏后按钮数等于在用策略数。
    const hideEmpty = page.getByRole('checkbox', { name: /隐藏本轮无结果策略/ });
    if (await hideEmpty.isChecked()) await hideEmpty.uncheck();
    assert.equal(await page.locator('.strategy-signal-tab-list > button').count(), require('../electron/strategy-signal-engine.cjs').STRATEGY_DEFINITIONS.length);
    assert.equal(await page.evaluate(() => window.savedSettings.length), 1);

  }, 'app'));
});
