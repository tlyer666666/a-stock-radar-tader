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
      import QuickNote from '/src/features/notes/QuickNote.tsx';
      ${cssImports}
      import { createPreviewApi } from '/src/previewApi.ts';
      window.calls = { notify: [], opened: [], spoken: [] };
      const api = createPreviewApi();
      api.notify = async message => { window.calls.notify.push(message); return { shown: true }; };
      window.calls.watch = []; window.calls.agent = []; window.nextHits = [];
      api.notesWatch = async input => { window.calls.watch.push(input); const hits = window.nextHits; window.nextHits = []; return { hits, watching: input.items.length, session: true }; };
      api.ai = { ...(api.ai || {}),
        parseNote: async input => { window.calls.parse = input; if (window.holdAi) await new Promise(resolve => { window.finishAi = resolve; }); return { text: '明天开盘看比亚迪 002594，跌破 280 减仓', when: '2026-11-13 09:30', repeat: 'none', code: '002594',
          condition: { field: 'latest', op: 'lte', value: 280 }, note: '跌破均价线要自己看', model: 'demo' }; },
        agent: { ...(api.ai?.agent || {}),
          start: async input => { window.calls.agent.push(input); return { runId: 'r' + window.calls.agent.length, conversationId: 'c1' }; },
          poll: async runId => ({ runId, conversationId: 'c1', status: 'done', steps: [], startedAt: '', elapsedMs: 10, model: 'demo',
            message: { id: 'm1', role: 'assistant', content: '**先别急着减仓**\\n\\n现价离 280 还有空间，盯住 275。', stance: '中性', at: new Date().toISOString() } }) } };
      window.stockApi = api;
      Object.defineProperty(window, 'speechSynthesis', { configurable: true, value: { speak: utterance => window.calls.spoken.push(utterance.text), cancel() {} } });
      function Host() {
        const notes = useNotes();
        const open = stock => window.calls.opened.push(stock.code);
        return React.createElement(React.Fragment, null,
          React.createElement('div', { className: 'quick-note-host' }, React.createElement(QuickNote, { api: notes, stock: { code: '600519', name: '贵州茅台', secid: '1.600519' } })),
          React.createElement(NotesView, { api: notes, onOpenStock: open, holdings: [{ code: '600519', name: '贵州茅台' }] }),
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

  test('价格条件：识别「跌破 280」、交给主进程盯；触发后弹提醒、自动让 AI 看，结论显示在卡片里', async () => {
    await pageTest(async page => {
      const input = page.getByLabel('随心记内容');
      await input.fill('002594 跌破 280 提醒我减仓');
      await page.locator('.notes-condition-chip', { hasText: '盯盘：价格 ≤ 280' }).waitFor();
      await page.getByRole('button', { name: /到点自动让 AI 先看：关/ }).click();
      await input.press('Enter');
      const card = page.locator('.notes-card', { hasText: '跌破 280' });
      await card.locator('.notes-badge', { hasText: '盯盘：价格 ≤ 280' }).waitFor();
      await page.locator('.notes-watch-status', { hasText: '盘中盯着 1 个价格条件' }).waitFor();
      const watched = await page.evaluate(() => window.calls.watch.at(-1));
      assert.deepEqual(watched.items[0].condition, { field: 'latest', op: 'lte', value: 280 });
      assert.equal(watched.items[0].code, '002594');

      await page.evaluate(id => { window.nextHits = [{ id, at: new Date().toISOString(), detail: '比亚迪 现价 279.5，已跌到 280 以下' }]; }, watched.items[0].id);
      await page.clock.fastForward('00:16');
      await page.locator('.notes-popup', { hasText: '价格条件到了' }).waitFor();
      assert.match(await page.locator('.notes-popup-detail').innerText(), /现价 279\.5/);
      assert.equal(await page.locator('.notes-watch-status').count(), 0, '触发后不再盯');
      await card.locator('.notes-ai.done').waitFor();
      const asked = await page.evaluate(() => window.calls.agent);
      assert.equal(asked.length, 1, '开了自动让 AI 先看');
      assert.deepEqual(asked[0].focus?.code, '002594');
      assert.match(asked[0].message, /已经触发：比亚迪 现价 279\.5/);
      assert.match(await card.locator('.notes-ai').innerText(), /先别急着减仓/);
      assert.match(await card.locator('.notes-ai').innerText(), /中性/);
      const notify = await page.evaluate(() => window.calls.notify);
      assert.ok(notify.some(item => /AI 看过了/.test(item.title) && /先别急着减仓/.test(item.body)), 'AI 看完再发一条通知');
      await page.screenshot({ path: path.join(screenshotDir, 'notes-condition-ai.png'), fullPage: true });

      // 再问一次接着同一段对话；重新盯会再次交给主进程。
      await page.locator('.notes-popup').getByRole('button', { name: '收起这条提醒' }).click();
      await card.getByRole('button', { name: '再问一次 AI' }).click();
      await page.waitForFunction(() => window.calls.agent.length === 2);
      assert.equal(await page.evaluate(() => window.calls.agent[1].conversationId), 'c1');
      await card.getByRole('button', { name: /重新盯/ }).click();
      await page.locator('.notes-watch-status', { hasText: '盘中盯着 1 个价格条件' }).waitFor();
    });
  });

  test('AI 整理：识别时间、股票和条件，确认后保存；可以撤销', async () => {
    await pageTest(async page => {
      const input = page.getByLabel('随心记内容');
      await input.fill('明早开盘瞅一眼比亚迪跌破280就减');
      await page.getByRole('button', { name: 'AI 整理' }).click();
      await page.locator('.notes-condition-chip', { hasText: '盯盘：价格 ≤ 280' }).waitFor();
      assert.equal(await input.inputValue(), '明天开盘看比亚迪 002594，跌破 280 减仓');
      assert.match(await page.locator('.notes-composer .notes-hint[role="status"]').innerText(), /明天 09:30 提醒；盘中价格 ≤ 280时提醒/);
      const sent = await page.evaluate(() => window.calls.parse);
      assert.match(sent.now, /^2026-11-12 14:00 周四$/);
      assert.equal(sent.tradingDays[1], '2026-11-13');
      await page.getByRole('button', { name: '撤销 AI 整理' }).click();
      assert.equal(await input.inputValue(), '明早开盘瞅一眼比亚迪跌破280就减');
      await page.getByRole('button', { name: 'AI 整理' }).click();
      await page.locator('.notes-condition-chip').waitFor();
      await page.getByRole('button', { name: '记下来' }).click();
      const card = page.locator('.notes-card', { hasText: '跌破 280 减仓' });
      assert.match(await card.innerText(), /明天 09:30 提醒/);
      assert.match(await card.innerText(), /盯盘：价格 ≤ 280/);
    });
  });

  test('个股页「记一笔」：自动关联股票，识别价格条件，记进随心记', async () => {
    await pageTest(async page => {
      await page.getByRole('button', { name: '记一笔' }).click();
      const box = page.getByLabel('记一笔内容');
      await box.fill('跌破 1500 减仓');
      await page.locator('.quick-note-foot', { hasText: '盘中价格 ≤ 1500时提醒' }).waitFor();
      await box.press('Enter');
      await page.getByRole('button', { name: '已记到随心记' }).waitFor();
      const card = page.locator('.notes-card', { hasText: '贵州茅台 600519：跌破 1500 减仓' });
      await card.locator('.notes-badge', { hasText: '盯盘：价格 ≤ 1500' }).waitFor();
      assert.equal(await page.locator('.quick-note-pop').count(), 0);
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

  test('复合时间和股票全名可直接录入，修改文案后自动重复同步更新', async () => {
    await pageTest(async page => {
      const input = page.getByLabel('随心记内容');
      await input.fill('每个交易日开盘前半小时看贵州茅台');
      await page.getByRole('radio', { name: /识别到：明天 09:00/ }).waitFor();
      assert.equal(await page.getByLabel('重复').inputValue(), 'tradingDays');
      await page.locator('.notes-stock-chip').filter({ hasText: '贵州茅台 600519' }).waitFor();
      await input.fill('明天开盘前半小时看贵州茅台');
      assert.equal(await page.getByLabel('重复').inputValue(), 'none');
      await input.press('Enter');
      assert.match(await page.locator('.notes-card').innerText(), /明天 09:00 提醒/);

      await input.fill('11月31日 14:30 看看');
      await page.getByText(/日期无效/).waitFor();
      assert.ok(await page.getByRole('button', { name: '记下来' }).isDisabled());
      await input.press('Enter');
      assert.equal(await page.locator('.notes-card').count(), 1);
    });
  });

  test('多个股票或价格条件须选定后才保存，主进程只收到选中的条件', async () => {
    await pageTest(async page => {
      const input = page.getByLabel('随心记内容');
      const save = page.getByRole('button', { name: '记下来' });
      await input.fill('贵州茅台和 002594，跌破 280 或涨幅超过 5% 提醒我');
      await page.getByText('识别到多只股票，请选择一只').waitFor();
      assert.ok(await save.isDisabled());
      await page.getByLabel('关联股票').selectOption('002594');
      await page.getByText('识别到多个价格条件，请选择一项').waitFor();
      assert.ok(await save.isDisabled());
      await page.getByLabel('盯盘条件').selectOption({ label: '涨幅 ≥ 5%' });
      await save.click();
      await page.locator('.notes-card').getByText('盯盘：涨幅 ≥ 5%').waitFor();
      await page.waitForFunction(() => window.calls.watch.at(-1)?.items.length === 1);
      const [watch] = await page.evaluate(() => window.calls.watch.at(-1).items);
      assert.equal(watch.code, '002594');
      assert.deepEqual(watch.condition, { field: 'changePct', op: 'gte', value: 5 });
    });
  });

  test('AI 晚返回不能改写新草稿，撤销恢复手选时间和重复设置', async () => {
    await pageTest(async page => {
      const input = page.getByLabel('随心记内容');
      await input.fill('旧草稿');
      await page.evaluate(() => { window.holdAi = true; });
      await page.getByRole('button', { name: 'AI 整理', exact: true }).click();
      await page.waitForFunction(() => typeof window.finishAi === 'function');
      await input.fill('新的草稿');
      await page.evaluate(() => { window.holdAi = false; window.finishAi(); });
      await page.getByRole('button', { name: 'AI 整理', exact: true }).waitFor();
      assert.equal(await input.inputValue(), '新的草稿');

      await page.getByRole('radio', { name: '1 小时后' }).click();
      await page.getByLabel('重复').selectOption('daily');
      await page.getByRole('button', { name: 'AI 整理', exact: true }).click();
      await page.getByRole('button', { name: '撤销 AI 整理' }).click();
      assert.equal(await input.inputValue(), '新的草稿');
      assert.equal(await page.getByRole('radio', { name: '1 小时后' }).getAttribute('aria-checked'), 'true');
      assert.equal(await page.getByLabel('重复').inputValue(), 'daily');
      await page.clock.fastForward('01:00');
      assert.match(await page.locator('.notes-composer [role="status"]').innerText(), /今天 15:00（每天）/);
    });
  });

});
