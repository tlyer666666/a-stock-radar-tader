'use strict';

// 做T助手（1.6.57）：在真实渲染器里用预览行情走一遍添加股票、填参数、看信号和分时、登记/删除成交、从持仓导入。
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

describe('做T助手 page in the actual renderer', () => {
  let browser, server, base;
  const screenshotDir = path.resolve(__dirname, '../artifacts/frontend-v150/t-assistant');

  before(async () => {
    const { createServer } = await import('vite');
    const mainSource = await fs.readFile(path.resolve(__dirname, '../src/main.tsx'), 'utf8');
    const cssImports = [...mainSource.matchAll(/^import "\.\/([^"\n]+\.css)";/gm)].map(match => `import '/src/${match[1]}';`).join('\n');
    const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import TAssistantView from '/src/features/t-assistant/TAssistantView.tsx';
      import { useTAssistant } from '/src/features/t-assistant/useTAssistant.ts';
      ${cssImports}
      import { createPreviewApi } from '/src/previewApi.ts';
      window.calls = { toasts: [], opened: [] };
      window.stockApi = createPreviewApi();
      const holdings = [
        { code: '000001', name: '平安银行', secid: '0.000001', assetType: 'stock', shares: 2000, costPrice: 12.3, createdAt: '', updatedAt: '' },
        { code: '510300', name: '沪深300ETF', secid: '1.510300', assetType: 'etf', shares: 1000, costPrice: 4, createdAt: '', updatedAt: '' }
      ];
      function Host() {
        const [live, setLive] = React.useState(true);
        window.setTLive = setLive;
        const api = useTAssistant({ live, onAlert: message => window.calls.toasts.push(message) });
        window.tApi = api;
        return React.createElement(TAssistantView, { api, holdings, live, onOpenStock: stock => window.calls.opened.push(stock.code), onToast: message => window.calls.toasts.push(message) });
      }
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
        React.createElement('div', { className: 'app-shell terminal-shell', 'data-workspace': 't-assistant' },
          React.createElement('div', { className: 'window-dragbar' }, '做T助手界面验证 · 预览行情'),
          React.createElement('aside', { className: 'sidebar' }, React.createElement('strong', null, '工作台'), React.createElement('button', { className: 'nav-item active' }, '做T助手')),
          React.createElement('main', { className: 'main' },
            React.createElement('header', { className: 'topbar' }, '预览行情 · 仅验证界面交互'),
            React.createElement('div', { className: 'page' }, React.createElement(Host)),
            React.createElement('footer', { className: 'terminal-statusbar' }, '预览数据')))));
    </script></body></html>`;
    server = await createServer({
      plugins: [{ name: 't-assistant-fixture', configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/__t_assistant__') return next();
          try { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(request.url, html)); } catch (error) { next(error); }
        });
      } }],
      server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error'
    });
    await server.listen();
    base = `http://127.0.0.1:${server.httpServer.address().port}/__t_assistant__`;
    browser = await require('playwright-core').chromium.launch({
      executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true
    });
    await fs.mkdir(screenshotDir, { recursive: true });
  });

  after(async () => { await browser?.close(); await server?.close(); });

  async function pageTest(run) {
    const page = await browser.newPage({ viewport: { width: 1480, height: 1000 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    try {
      await page.goto(base);
      await page.locator('.t-assistant-view').waitFor();
      await run(page);
      assert.deepEqual(errors, [], 'the renderer must not throw');
    } finally { await page.close(); }
  }

  test('添加股票、填参数、看信号与分时，登记成交后跟踪未完成的T', async () => {
    await pageTest(async page => {
      await page.locator('.t-assistant-empty').waitFor();
      await page.getByLabel('添加做T股票').fill('600519');
      await page.locator('.t-assistant-options [role="option"]').first().waitFor();
      await page.locator('.t-assistant-options [role="option"] button').first().click();
      await page.locator('.t-assistant-signal').waitFor();
      assert.equal(await page.locator('.t-assistant-row').count(), 1);
      assert.match(await page.locator('.t-assistant-signal').innerText(), /先填底仓/, '没有底仓时提示先填');

      const fields = page.locator('.t-assistant-fields input');
      await fields.nth(0).fill('900'); await fields.nth(0).press('Enter');
      await fields.nth(1).fill('900'); await fields.nth(1).press('Enter');
      await fields.nth(2).fill('40'); await fields.nth(2).press('Enter');
      await page.waitForFunction(() => document.querySelectorAll('.t-assistant-fields input')[3]?.value === '300');
      assert.doesNotMatch(await page.locator('.t-assistant-signal').innerText(), /先填底仓/);
      assert.equal(await page.locator('.t-chart svg polyline').count(), 2, '价格线和均价线');
      assert.ok(await page.locator('.t-chart-level.upper').count() === 1 && await page.locator('.t-chart-level.lower').count() === 1);
      assert.match(await page.locator('.t-assistant-note').innerText(), /每次 300 股/);

      await page.getByRole('button', { name: '登记成交' }).click();
      const form = page.locator('.t-assistant-form');
      await form.getByLabel('价格').fill('39.50');
      await form.getByLabel('股数').fill('300');
      await form.getByLabel('时间').fill('10:30');
      await form.getByRole('button', { name: '保存' }).click();
      await page.locator('.t-assistant-table tbody tr').first().waitFor();
      assert.match(await page.locator('.t-assistant-open').innerText(), /倒T进行中：10:30 卖出 300 股/);
      assert.match(await page.locator('.t-assistant-row').innerText(), /倒T待接回 300/);
      assert.equal(await page.locator('.t-chart-trade.sell').count(), 1);
      await page.screenshot({ path: path.join(screenshotDir, 't-assistant.png'), fullPage: true });

      await page.reload();
      await page.locator('.t-assistant-table tbody tr').first().waitFor();
      assert.equal(await page.locator('.t-assistant-table tbody tr').count(), 1, '成交登记保存在本机');
      await page.getByRole('button', { name: /删除 10:30 的成交/ }).click();
      assert.equal(await page.locator('.t-assistant-table').count(), 0);

      await page.getByRole('button', { name: '隐藏回放' }).click();
      assert.equal(await page.locator('.t-chart-virtual').count(), 0);
      await page.getByRole('button', { name: '个股详情' }).click();
      assert.deepEqual(await page.evaluate(() => window.calls.opened), ['600519']);
      await page.getByRole('button', { name: '不再跟踪' }).click();
      await page.locator('.t-assistant-empty').waitFor();
    });
  });

  test('从持仓导入：只导入填了股数的 A 股，底仓和成本按持仓填写', async () => {
    await pageTest(async page => {
      await page.getByRole('button', { name: '从持仓导入' }).click();
      await page.locator('.t-assistant-row').first().waitFor();
      assert.equal(await page.locator('.t-assistant-row').count(), 1, 'ETF 不导入');
      assert.match(await page.locator('.t-assistant-row').innerText(), /平安银行/);
      const fields = page.locator('.t-assistant-fields input');
      assert.equal(await fields.nth(0).inputValue(), '2000');
      assert.equal(await fields.nth(1).inputValue(), '', '持仓导入不能假定当日买入的股份可卖');
      assert.equal(await fields.nth(2).inputValue(), '12.3');
      assert.equal(await fields.nth(3).inputValue(), '600');
      assert.match((await page.evaluate(() => window.calls.toasts)).join(), /已从持仓导入 1 只/);
      await page.getByRole('button', { name: /语音提醒开/ }).click();
      await page.getByRole('button', { name: /语音提醒关/ }).waitFor();
    });
  });
  test('旧日分时保留历史信号，禁止当日提醒；更新为新鲜行情后只提醒一次', async () => {
    await pageTest(async page => {
      await page.clock.setFixedTime(new Date('2026-11-09T10:22:00+08:00'));
      await page.evaluate(() => {
        window.quoteDay = '2026-11-06';
        window.stockApi.getChart = async () => ({ preClose: 10, rows: [...Array(50).fill(10), 10.4, 10.38, 10.36].map((close, slot) => ({
          date: window.quoteDay + ' ' + String(Math.floor((570 + slot) / 60)).padStart(2, '0') + ':' + String((570 + slot) % 60).padStart(2, '0'),
          open: 10, close, volume: 100
        })) });
        window.tApi.addStock({code: '600000', name: '浦发银行'}, {baseShares: 3000, sellableShares: 3000, tShares: 1000});
      });
      await page.locator('.t-assistant-signal').waitFor();
      assert.match(await page.locator('.t-assistant-signal').innerText(), /历史参考/);
      assert.match(await page.locator('.t-assistant-signal').innerText(), /高抛/);
      assert.equal(await page.getByRole('button', {name: '我已成交，登记一笔'}).count(), 0);
      assert.deepEqual(await page.evaluate(() => window.calls.toasts), []);
      await page.evaluate(async () => { window.quoteDay = '2026-11-09'; await window.tApi.refresh(); });
      await page.getByRole('button', {name: '我已成交，登记一笔'}).waitFor();
      await page.waitForFunction(() => window.calls.toasts.some(message => message.includes('做T提示')));
      await page.evaluate(async () => { await window.tApi.refresh(); window.tApi.setVoice(false); });
      assert.equal((await page.evaluate(() => window.calls.toasts.filter(message => message.includes('做T提示')))).length, 1);
      await page.evaluate(() => window.setTLive(false));
      await page.getByText(/已暂停实时刷新（顶部/).waitFor();
      assert.equal(await page.getByRole('button', {name: '我已成交，登记一笔'}).count(), 0, 'paused quotes must not offer an actionable signal');
      await page.evaluate(() => window.setTLive(true));
      await page.getByRole('button', {name: '我已成交，登记一笔'}).waitFor();
      await page.evaluate(async () => { window.stockApi.getChart = async () => { throw new Error('行情连接断开'); }; await window.tApi.refresh(); });
      await page.getByText(/分时读取失败：行情连接断开/).waitFor();
      assert.equal(await page.getByRole('button', {name: '我已成交，登记一笔'}).count(), 0);
    });
  });

});
