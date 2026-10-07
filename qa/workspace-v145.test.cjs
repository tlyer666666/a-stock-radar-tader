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
  openBoardCount: index % 3, turnover: 2.3 + index,
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
              items, limitUps: ${JSON.stringify(boardRows)}, activeNode, onNodeChange: setActiveNode,
              onOpen(item) { window.callbacks.opened.push(item.code); },
              onRemove(item) { window.callbacks.removed.push(item.code); setItems(current => current.filter(row => row.code !== item.code)); }
            })),
            React.createElement('footer', { className: 'terminal-statusbar' }, '合成数据 · 浏览器交互检查')));
      }
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
        React.createElement(new URLSearchParams(location.search).get('mode') === 'app' ? App : WatchHarness)));
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
      await page.locator(mode === 'watch' ? '.watch-stock-table tbody tr' : '.workspace-navigation').first().waitFor();
      await run(page);
      assert.deepEqual(errors, [], 'the real renderer must not throw during interaction');
    } finally { await page.close(); }
  }

  test('398 stocks render twenty rows and paging reaches the next distinct twenty', async () => pageTest(async page => {
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 20);
    assert.match(await page.locator('.watch-pagination').innerText(), /1–20 \/ 398/);
    assert.equal(await page.getByRole('button', { name: '观察池上一页' }).isDisabled(), true);
    assert.match(await page.locator('.watch-stock-table tbody tr').first().innerText(), /600001/);
    await page.getByRole('button', { name: '观察池下一页' }).click();
    await page.getByText('21–40 / 398 只', { exact: true }).waitFor();
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 20);
    assert.match(await page.locator('.watch-stock-table tbody tr').first().innerText(), /600021/);
    assert.equal(await page.getByRole('button', { name: '观察池上一页' }).isEnabled(), true);
  }));

  test('every trading-day tab reports and filters its complete count while resetting pagination', async () => pageTest(async page => {
    await page.getByRole('button', { name: '观察池下一页' }).click();
    for (let day = 1; day <= 10; day++) {
      const count = day <= 8 ? 40 : 39;
      const tab = page.getByRole('group', { name: '观察交易日' }).getByRole('button', { name: new RegExp(`^T\\+${day}\\s*${count}$`) });
      await tab.click();
      await page.waitForFunction(node => [...document.querySelectorAll('.watch-day-badge')].every(badge => badge.textContent === node), `T+${day}`);
      assert.equal(await tab.getAttribute('aria-pressed'), 'true');
      assert.equal(await tab.locator('b').innerText(), String(count));
      assert.match(await page.locator('.watch-pagination').innerText(), new RegExp(`1–20 \\/ ${count}`));
      assert.deepEqual(await page.locator('.watch-day-badge').allTextContents(), Array(20).fill(`T+${day}`));
      assert.match(await page.locator('.watch-stock-table tbody tr').first().innerText(), new RegExp(String(600000 + day)));
    }
  }));

  test('name and code filters find off-page stocks, and clearing restores the first page', async () => pageTest(async page => {
    await page.getByRole('button', { name: '观察池下一页' }).click();
    const input = page.getByRole('textbox', { name: '筛选观察池股票名称或代码' });
    await input.fill('末页目标');
    await page.getByText('1–1 / 1 只', { exact: true }).waitFor();
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 1);
    assert.match(await page.locator('.watch-stock-table tbody tr').innerText(), /末页目标股份[\s\S]*600398/);
    await input.fill('600398');
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 1);
    await input.fill('不存在的股票');
    await page.getByRole('heading', { name: '没有匹配的股票' }).waitFor();
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 0);
    await page.getByRole('button', { name: '清空观察池筛选' }).click();
    await page.getByText('1–20 / 398 只', { exact: true }).waitFor();
    assert.equal(await input.inputValue(), '');
    assert.equal(await page.locator('.watch-stock-table tbody tr').count(), 20);
  }));

  test('stock opening, row analysis, removing and ladder opening dispatch only their intended callback', async () => pageTest(async page => {
    await page.locator('.watch-stock-open').first().click();
    await page.getByRole('button', { name: '分析观察样本002', exact: true }).click();
    await page.getByRole('button', { name: '移出观察池观察样本003', exact: true }).click();
    await page.getByText('1–20 / 397 只', { exact: true }).waitFor();
    assert.equal(await page.locator('.watch-stock-open').filter({ hasText: '观察样本003' }).count(), 0);
    await page.locator('.board-ladder-stock[data-code="601001"]').click();
    assert.deepEqual(await page.evaluate(() => window.callbacks), {
      opened: ['600001', '600002', '601001'], removed: ['600003']
    });
  }));

  test('compact desktop density and stacked narrow layout preserve readable rows without page overflow', async () => pageTest(async page => {
    assert.deepEqual(await page.locator('.board-ladder-level').evaluateAll(rows => rows.map(row => row.dataset.boardHeight)), ['7', '4', '3', '2']);
    for (const theme of ['dark', 'light']) for (const width of [1280, 1480, 1920, 1024]) {
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      await page.setViewportSize({ width, height: 960 });
      await page.locator('.main > .page').evaluate(element => { element.scrollTop = 0; });
      const layout = await page.evaluate(() => {
        const bounds = selector => document.querySelector(selector).getBoundingClientRect();
        const page = document.querySelector('.main > .page');
        const workspace = document.querySelector('.ten-day-workspace');
        const list = bounds('.watch-stock-panel'), ladder = bounds('.watch-ladder-sidebar');
        const stockCards = [...document.querySelectorAll('.board-ladder-stock')];
        const rowBounds = [...document.querySelectorAll('.watch-stock-table tbody tr')].map(row => row.getBoundingClientRect());
        const tableBounds = bounds('.watch-table-scroll');
        const tableHeaderBounds = bounds('.watch-stock-table thead');
        return {
          documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          pageOverflow: page.scrollWidth - page.clientWidth,
          workspaceOverflow: workspace.scrollWidth - workspace.clientWidth,
          listWidth: list.width, ladderWidth: ladder.width, listTop: list.top, ladderTop: ladder.top,
          ladderLeft: ladder.left, listRight: list.right, listBottom: list.bottom,
          paginationBottom: bounds('.watch-pagination').bottom, viewportHeight: window.innerHeight,
          statusbarTop: bounds('.terminal-statusbar').top,
          firstRowTop: rowBounds[0].top, rowHeight: rowBounds[0].height,
          visibleRowCount: rowBounds.filter(row => row.top >= tableHeaderBounds.bottom - 1 && row.bottom <= tableBounds.bottom + 1).length,
          tabHeight: bounds('.watch-node-tabs button').height,
          clippedLadderCards: stockCards.filter(card => card.getBoundingClientRect().right > ladder.right + 1).length,
          visibleRows: document.querySelectorAll('.watch-stock-table tbody tr').length
        };
      });
      const context = `${theme} ${width}: ${JSON.stringify(layout)}`;
      assert.ok(layout.documentOverflow <= 2 && layout.pageOverflow <= 2 && layout.workspaceOverflow <= 2, context);
      assert.ok(layout.rowHeight >= 28 && layout.rowHeight <= 40, context);
      assert.ok(layout.tabHeight <= 42, context);
      assert.ok(layout.firstRowTop < 280, context);
      assert.ok(layout.visibleRowCount >= 15, context);
      if (width >= 1280) {
        assert.ok(layout.listWidth > layout.ladderWidth * 1.5, context);
        assert.ok(Math.abs(layout.listTop - layout.ladderTop) <= 2 && layout.ladderLeft >= layout.listRight, context);
        assert.ok(layout.paginationBottom <= layout.statusbarTop, context);
      } else {
        assert.ok(layout.ladderTop >= layout.listBottom, context);
        assert.ok(Math.abs(layout.listWidth - layout.ladderWidth) <= 2, context);
      }
      assert.equal(layout.clippedLadderCards, 0, context);
      assert.equal(layout.visibleRows, 20, context);
      await page.screenshot({ path: path.join(screenshotDir, `watch-workspace-${theme}-${width}.png`), animations: 'disabled' });
    }
  }));

  test('all fifteen quick combinations are reachable and selecting one persists its actual factor set', async () => pageTest(async page => {
    await page.getByRole('button', { name: '数据源设置', exact: true }).click();
    await page.getByRole('navigation', { name: '设置分类' }).getByRole('button', { name: '策略组合', exact: true }).click();
    await page.locator('.strategy-presets').waitFor();
    assert.equal(await page.locator('.strategy-presets > button').count(), 16, 'fifteen presets plus all factors');
    await page.locator('.strategy-quick-trigger').click();
    const menu = page.locator('.strategy-quick-menu');
    assert.equal(await menu.locator('button:not(.strategy-custom-link)').count(), 15);
    await page.keyboard.press('Escape');
    assert.equal(await menu.count(), 0, 'Escape dismisses the strategy overlay');
    await page.locator('.strategy-quick-trigger').click();
    await page.locator('.page-heading h1').click();
    assert.equal(await menu.count(), 0, 'outside click dismisses the strategy overlay');
    await page.locator('.strategy-quick-trigger').click();
    const bounds = await menu.evaluate(element => ({ height: element.clientHeight, contentHeight: element.scrollHeight, bottom: element.getBoundingClientRect().bottom }));
    assert.ok(bounds.contentHeight > bounds.height && bounds.bottom <= 960, JSON.stringify(bounds));
    await menu.getByRole('button', { name: /突破跟随/ }).click();
    await page.waitForFunction(() => window.savedSettings.length === 1);
    assert.deepEqual(await page.evaluate(() => window.savedSettings[0].selectedStrategies),
      ['secondBreakout', 'trend', 'avwap', 'sectorLeader', 'volatility', 'support', 'riskVeto']);
    assert.match(await page.locator('.strategy-quick-trigger').innerText(), /突破跟随/);
    await page.locator('.strategy-presets').getByRole('button', { name: /首板观察节点/ }).click();
    await page.getByRole('button', { name: '保存策略组合', exact: true }).click();
    await page.waitForFunction(() => window.savedSettings.length === 2);
    assert.deepEqual(await page.evaluate(() => window.savedSettings[1].selectedStrategies),
      ['firstBoardQuality', 'lowFirstBoard', 'exactNode', 'avwap', 'support', 'riskVeto']);
    assert.match(await page.locator('.strategy-quick-trigger').innerText(), /首板观察节点/);
  }, 'app'));
});
