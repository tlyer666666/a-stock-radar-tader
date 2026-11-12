'use strict';

// 随心记（1.6.62）：在真实渲染器里记一条带时间的想法，拨快时钟到点，看提醒卡片、系统通知和完成/稍后提醒。
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

describe('随心记 page in the actual renderer', () => {
  let browser, server, base;
  const screenshotDir = path.resolve(__dirname, '../artifacts/frontend-v150/notes');

  before(async () => {
    const { createServer } = await import('vite');
    const mainSource = await fs.readFile(path.resolve(__dirname, '../src/main.tsx'), 'utf8');
    const cssImports = [...mainSource.matchAll(/^import "\.\/([^"\n]+\.css)";/gm)].map(match => `import '/src/${match[1]}';`).join('\n');
    const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import NotesView, { NoteReminderStack } from '/src/features/notes/NotesView.tsx';
      import { useNotes } from '/src/features/notes/useNotes.ts';
      ${cssImports}
      import { createPreviewApi } from '/src/previewApi.ts';
      window.calls = { notify: [], opened: [], spoken: [] };
      const api = createPreviewApi();
      api.notify = async message => { window.calls.notify.push(message); return { shown: true }; };
      window.stockApi = api;
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: utterance => window.calls.spoken.push(utterance.text), cancel() {} } });
      function Host() {
        const notes = useNotes();
        const open = stock => window.calls.opened.push(stock.code);
        return React.createElement(React.Fragment, null,
          React.createElement(NotesView, { api: notes, onOpenStock: open }),
          React.createElement(NoteReminderStack, { api: notes, onOpenNotes: () => {}, onOpenStock: open }));
      }
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
        React.createElement('div', { className: 'app-shell terminal-shell', 'data-workspace': 'notes' },
          React.createElement('div', { className: 'window-dragbar' }, '随心记界面验证'),
          React.createElement('aside', { className: 'sidebar' }, React.createElement('strong', null, '工作台'), React.createElement('button', { className: 'nav-item active' }, '随心记')),
          React.createElement('main', { className: 'main' },
            React.createElement('header', { className: 'topbar' }, '预览'),
            React.createElement('div', { className: 'page' }, React.createElement(Host)),
            React.createElement('footer', { className: 'terminal-statusbar' }, '预览数据')))));
    </script></body></html>`;
    server = await createServer({
      plugins: [{ name: 'notes-fixture', configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/__notes__') return next();
          try { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(request.url, html)); } catch (error) { next(error); }
        });
      } }],
      server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error'
    });
    await server.listen();
    base = `http://127.0.0.1:${server.httpServer.address().port}/__notes__`;
    browser = await require('playwright-core').chromium.launch({
      executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true
    });
    await fs.mkdir(screenshotDir, { recursive: true });
  });

  after(async () => { await browser?.close(); await server?.close(); });

  async function pageTest(run) {
    const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('dialog', dialog => dialog.accept());
    page.setDefaultTimeout(8000);
    try {
      // 北京时间 2026-11-12（周四）14:00。
      await page.clock.install({ time: new Date('2026-11-12T14:00:00+08:00') });
      await page.goto(base);
      await page.locator('.notes-view').waitFor();
      await run(page);
      assert.deepEqual(errors, [], 'the renderer must not throw');
    } finally { await page.close(); }
  }

  test('写一条「30分钟后」：识别时间、保存、到点弹出提醒并发系统通知，完成后收起', async () => {
    await pageTest(async page => {
      const input = page.getByLabel('随心记内容');
      await input.fill('30分钟后看 600519 分时，跌破均价线就减仓');
      await page.getByRole('radio', { name: /识别到：今天 14:30/ }).waitFor();
      await page.locator('.notes-stock-chip').filter({ hasText: '贵州茅台' }).waitFor();
      await input.press('Enter');
      await page.locator('.notes-card.scheduled').waitFor();
      assert.match(await page.locator('.notes-card').innerText(), /今天 14:30 提醒/);
      assert.equal(await input.inputValue(), '', '保存后清空输入框');

      await input.fill('这只票的逻辑是订单落地');
      await page.getByRole('button', { name: '记下来' }).click();
      assert.equal(await page.locator('.notes-card').count(), 2);
      assert.equal(await page.locator('.notes-card.plain').count(), 1, '没写时间的只记录');

      await page.clock.fastForward('31:00');
      await page.locator('.notes-popup').waitFor();
      assert.match(await page.locator('.notes-popup').innerText(), /跌破均价线就减仓/);
      const notify = await page.evaluate(() => window.calls.notify);
      assert.equal(notify.length, 1);
      assert.match(notify[0].body, /600519/);
      assert.equal((await page.evaluate(() => window.calls.spoken)).length, 1);
      await page.locator('.notes-card.awaiting').waitFor();
      await page.screenshot({ path: path.join(screenshotDir, 'notes.png'), fullPage: true });

      await page.clock.fastForward('01:00');
      assert.equal((await page.evaluate(() => window.calls.notify)).length, 1, '同一条不反复提醒');

      await page.locator('.notes-popup').getByRole('button', { name: '看 贵州茅台' }).click();
      assert.deepEqual(await page.evaluate(() => window.calls.opened), ['600519']);
      assert.equal(await page.locator('.notes-popup').count(), 0);
      await page.locator('.notes-card.awaiting').getByRole('button', { name: '完成' }).click();
      await page.getByRole('tab', { name: /已完成/ }).click();
      assert.equal(await page.locator('.notes-card.done').count(), 1);

      await page.reload();
      await page.getByRole('tab', { name: /全部/ }).click();
      assert.equal(await page.locator('.notes-card').count(), 2, '保存在本机，重开还在');
    });
  });

  test('稍后提醒、编辑、删除；每个交易日的重复提醒到点后排到下一个交易日', async () => {
    await pageTest(async page => {
      const input = page.getByLabel('随心记内容');
      await input.fill('每个交易日 14:10 检查仓位');
      await page.getByRole('radio', { name: /识别到：今天 14:10/ }).waitFor();
      assert.equal(await page.getByLabel('重复').first().inputValue(), 'tradingDays');
      await input.press('Enter');
      await page.clock.fastForward('10:30');
      await page.locator('.notes-popup').waitFor();
      await page.locator('.notes-popup').getByRole('button', { name: /知道了（下次 明天 14:10）/ }).click();
      assert.match(await page.locator('.notes-card').innerText(), /明天 14:10 提醒 · 每个交易日/);

      await input.fill('明天开盘前挂单');
      await page.getByRole('radio', { name: '1 小时后' }).click();
      await input.press('Enter');
      const card = page.locator('.notes-card', { hasText: '明天开盘前挂单' });
      assert.match(await card.innerText(), /今天 15:10 提醒/, '手选的时间优先于自动识别');
      await card.getByRole('button', { name: /稍后提醒/ }).click();
      await card.getByRole('button', { name: '下个交易日尾盘' }).click();
      assert.match(await card.innerText(), /明天 14:45 提醒/);

      await card.getByRole('button', { name: /编辑/ }).click();
      await page.getByLabel('编辑内容').fill('明天开盘前挂单 10.20');
      await page.getByRole('button', { name: '保存' }).click();
      await page.locator('.notes-card', { hasText: '10.20' }).waitFor();
      await page.locator('.notes-card', { hasText: '10.20' }).getByRole('button', { name: '删除这条' }).click();
      await page.getByRole('dialog').getByRole('button', { name: '删除' }).click();
      assert.equal(await page.locator('.notes-card', { hasText: '10.20' }).count(), 0);
    });
  });
});
