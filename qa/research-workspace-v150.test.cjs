'use strict';

const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const library = require('../config/trend-strategy-library.json');

describe('v1.5 research workspace in an isolated real renderer', () => {
  let browser, server, base;
  const output = path.resolve(__dirname, '../artifacts/frontend-v150/research');
  before(async () => {
    const { createServer } = await import('vite');
    const main = await fs.readFile(path.resolve(__dirname, '../src/main.tsx'), 'utf8');
    const styles = [...main.matchAll(/import\s+["']\.\/([^"']+\.css)["']/g)].map(match => `import '/src/${match[1]}';`).join('\n');
    const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import TrendScreenerView from '/src/TrendScreenerView.tsx';
      import StrategySignalsView from '/src/StrategySignalsView.tsx';
      import { createPreviewApi } from '/src/previewApi.ts';
      ${styles}
      window.stockApi = createPreviewApi(); window.calls = { opened: [], backtests: [] };
      const signals = new URLSearchParams(location.search).get('view') === 'signals';
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
        React.createElement('div', { className: 'terminal-shell', style: { padding: 12, minWidth: 0 } },
          React.createElement(signals ? StrategySignalsView : TrendScreenerView, {
            onOpen: item => window.calls.opened.push(item), onOpenBacktest: request => window.calls.backtests.push(request)
          }))));
    </script></body></html>`;
    server = await createServer({ plugins: [{ name: 'research-v150-fixture', configureServer(vite) {
      vite.middlewares.use(async (request, response, next) => {
        if (request.url?.split('?')[0] !== '/__research_v150__') return next();
        try { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(request.url, html)); }
        catch (error) { next(error); }
      });
    } }], server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
    await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}/__research_v150__`;
    browser = await require('playwright-core').chromium.launch({ executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    await fs.mkdir(output, { recursive: true });
  });
  after(async () => { await browser?.close(); await server?.close(); });
  async function run(view, body) {
    const page = await browser.newPage({ viewport: { width: 1480, height: 960 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(5000);
    try {
      await page.goto(`${base}?view=${view}`);
      await page.locator(view === 'trend' ? '.trend-results-context' : '.strategy-signal-tab-list > button').first().waitFor();
      await body(page); assert.deepEqual(errors, [], 'no renderer exception during research interactions');
    } finally { await page.close(); }
  }

  test('candidate rows expand without remounting a calculator or losing an unsaved draft across filters and tabs', () => run('trend', async page => {
    assert.equal(await page.locator('.trend-result-table').count(), 1, 'candidates use a compact result table');
    assert.equal(await page.locator('.trend-candidate, .trend-result-details .trend-calculator').count(), 0, 'unopened candidates do not render full cards or calculators');
    const row = page.locator('.trend-result-row').first();
    await row.getByRole('button', { name: /详情/ }).click();
    const card = page.locator('.trend-result-details:visible .trend-candidate').first();
    await card.locator('.trend-calculator > summary').click();
    const nav = card.getByRole('spinbutton', { name: '账户净资产', exact: true });
    await nav.fill('123456');
    await nav.evaluate(element => { element.dataset.mountMarker = 'original'; });
    await row.getByRole('button', { name: /收起/ }).click();
    assert.equal(await card.isVisible(), false);
    await page.getByRole('textbox', { name: '搜索代码或名称' }).fill('不存在');
    await page.getByRole('textbox', { name: '搜索代码或名称' }).fill('');
    await page.getByRole('button', { name: /^我的计划/ }).click();
    await page.getByRole('button', { name: /^研究候选/ }).click();
    await row.getByRole('button', { name: /详情/ }).click();
    assert.equal(await nav.inputValue(), '123456');
    assert.equal(await nav.getAttribute('data-mount-marker'), 'original');
    await card.getByRole('button', { name: '加入我的计划', exact: true }).click();
    await page.getByRole('button', { name: /^我的计划/ }).click();
    await page.locator('.trend-result-row:visible').first().getByRole('button', { name: /详情/ }).click();
    const saved = page.locator('.trend-result-details:visible .trend-candidate').first();
    await saved.locator('.trend-calculator > summary').click();
    assert.equal(await saved.getByRole('spinbutton', { name: '账户净资产', exact: true }).inputValue(), '123456');
    assert.match(await saved.locator('.trend-snapshot-notice').innerText(), /历史快照/);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出计划 CSV' }).click();
    assert.match((await download).suggestedFilename(), /我的计划.*\.csv$/);
    await saved.getByRole('button', { name: /^移除/ }).click();
    assert.equal(await page.locator('.trend-result-row:visible').count(), 0);
  }));

  test('folded scan configuration retains quality inputs and all strategy controls', () => run('trend', async page => {
    const config = page.locator('.trend-scan-configuration');
    assert.equal(await config.count(), 1, 'configuration has an explicit disclosure');
    assert.equal(await config.getAttribute('open'), null);
    await config.locator(':scope > summary').click();
    assert.equal(await config.locator('.trend-library-choice').count(), library.length + 2);
    await config.locator('.trend-quality-parameters > summary').click();
    const input = config.locator('.trend-quality-parameters input').first();
    await input.fill('1.7');
    await config.locator(':scope > summary').click(); await config.locator(':scope > summary').click();
    assert.equal(await input.inputValue(), '1.7');
    await config.getByRole('textbox', { name: '查找趋势策略' }).fill('MACD');
    assert.ok(await config.locator('.trend-library-choice').count() > 0);
    await config.getByRole('button', { name: '单策略扫描', exact: true }).click();
    assert.equal(await config.getByRole('combobox', { name: '扫描策略', exact: true }).isVisible(), true);
    await config.locator('.trend-library-reference > summary').click();
    assert.equal(await config.locator('.trend-library-reference a:visible').count(), library.reduce((count, strategy) => count + strategy.sources.length, 0));
  }));

  test('signal results precede full evidence while catalog, stock callbacks, and folded tester stay usable', () => run('signals', async page => {
    const tester = page.locator('.signal-test-disclosure');
    assert.equal(await tester.count(), 1);
    assert.equal(await tester.getAttribute('open'), null);
    await page.locator('.strategy-signal-tab-list > button.state-verified').first().click();
    await page.locator('.strategy-stock-row:not(.head)').first().waitFor();
    assert.equal(await page.locator('.strategy-stock-panel').evaluate(element => Boolean(element.compareDocumentPosition(document.querySelector('.signal-rule-details')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
    await page.getByRole('button', { name: '带入回测中心', exact: true }).click();
    await page.locator('.strategy-stock-row:not(.head)').first().getByRole('button', { name: '详细复盘' }).click();
    await page.locator('.strategy-stock-row:not(.head)').first().getByRole('button', { name: '用该策略回测' }).click();
    const calls = await page.evaluate(() => window.calls);
    assert.equal(calls.opened.length, 1); assert.equal(calls.backtests.length, 2);
    assert.ok(calls.backtests[0].securities.length > 0); assert.equal(calls.backtests[1].security.code, calls.opened[0].code);
    await page.locator('.signal-rule-details > summary').click();
    assert.equal(await page.locator('.strategy-rule-panel').isVisible(), true);
    await page.locator('.signal-validation-details > summary').click();
    assert.equal(await page.locator('.strategy-validation').isVisible(), true);
    await tester.locator(':scope > summary').click();
    assert.equal(await tester.locator('.signal-stock-tester').isVisible(), true);
    const testInput = tester.getByRole('combobox', { name: '测试股票：代码或名称' });
    await testInput.fill('平安');
    await testInput.evaluate(element => { element.dataset.mountMarker = 'original'; });
    await tester.locator(':scope > summary').click(); await tester.locator(':scope > summary').click();
    assert.equal(await testInput.inputValue(), '平安');
    assert.equal(await testInput.getAttribute('data-mount-marker'), 'original');
    const search = page.getByRole('textbox', { name: '搜索信号策略' });
    await search.fill('不存在'); assert.equal(await page.locator('.strategy-signal-tab-list > button').count(), 0);
    await search.fill(''); assert.ok(await page.locator('.strategy-signal-tab-list > button').count() >= 14);
  }));

  for (const view of ['trend', 'signals']) test(`${view}: compact readable results and local horizontal scrolling in both themes`, () => run(view, async page => {
    for (const theme of ['dark', 'light']) for (const width of [1480, 1180, 1024, 760]) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
      const measure = await page.evaluate(view => {
        const root = document.querySelector(view === 'trend' ? '.trend-screener' : '.strategy-signals-view');
        const table = root.querySelector(view === 'trend' ? '.trend-result-table' : '.strategy-stock-table');
        const directory = root.querySelector('.strategy-signal-tabs');
        return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          rootOverflow: root.scrollWidth - root.clientWidth, tableTop: table?.getBoundingClientRect().top,
          heading: getComputedStyle(root.querySelector('h1')).fontSize,
          rowHeight: root.querySelector('.trend-result-row')?.getBoundingClientRect().height,
          directoryWidth: directory?.getBoundingClientRect().width };
      }, view);
      const context = `${view} ${theme} ${width}: ${JSON.stringify(measure)}`;
      assert.ok(measure.overflow <= 2 && measure.rootOverflow <= 2, context);
      assert.equal(measure.heading, '18px', context);
      if (view === 'trend') { assert.ok(measure.tableTop < 400, context); assert.ok(measure.rowHeight <= 56, context); }
      if (view === 'signals' && width >= 1180) assert.ok(measure.directoryWidth >= 220 && measure.directoryWidth <= 240, context);
      if (width === 1480 || width === 760) await page.screenshot({ path: path.join(output, `${view}-${theme}-${width}.png`), fullPage: false });
    }
  }));
});
