'use strict';

// 数据备份（1.6.64）：在真实渲染器里选网盘文件夹、设密码、立即备份、从备份恢复（主进程用假接口代替）。
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

describe('数据备份 card in the actual renderer', () => {
  let browser, server, base;
  const screenshotDir = path.resolve(__dirname, '../artifacts/frontend-v150/backup');

  before(async () => {
    const { createServer } = await import('vite');
    const mainSource = await fs.readFile(path.resolve(__dirname, '../src/main.tsx'), 'utf8');
    const cssImports = [...mainSource.matchAll(/^import "\.\/([^"\n]+\.css)";/gm)].map(match => `import '/src/${match[1]}';`).join('\n');
    const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import { BackupSettingsCard } from '/src/features/backup/BackupSettingsCard.tsx';
      ${cssImports}
      import { createPreviewApi } from '/src/previewApi.ts';
      const icloud = '/Users/me/Library/Mobile Documents/com~apple~CloudDocs/A股雷达备份';
      const state = { folder: '', auto: true, keep: 30, lastBackupAt: '', lastError: '', hasPassword: false, files: [], suggestions: [{ label: 'iCloud 云盘', path: icloud }] };
      window.calls = { runs: [], restored: [], relaunch: 0, passwords: [] };
      localStorage.setItem('a-stock-radar:notes:v1', '{"notes":["现在的"]}');
      localStorage.setItem('other:key', 'keep');
      const snapshot = () => structuredClone(state);
      const backup = {
        status: async () => snapshot(),
        chooseFolder: async () => { state.folder = '/Users/me/自选文件夹'; return snapshot(); },
        configure: async patch => {
          if (patch.suggestedFolder) state.folder = patch.suggestedFolder;
          if (typeof patch.auto === 'boolean') state.auto = patch.auto;
          if (patch.keep) state.keep = patch.keep;
          if (typeof patch.password === 'string') { state.hasPassword = Boolean(patch.password); window.calls.passwords.push(patch.password); }
          return snapshot();
        },
        run: async local => { window.calls.runs.push(local); state.files.unshift({ name: 'A股雷达备份-20261112-160509.json', size: 20480 }); state.lastBackupAt = '2026-11-12T08:05:09.000Z'; return { name: state.files[0].name, size: 20480, status: snapshot() }; },
        inspect: async (name, password) => { if (state.hasPassword && password !== 'abc123') throw new Error('[BACKUP_WRONG_PASSWORD] 备份密码不对'); return { createdAt: '', appVersion: '1.6.64', stores: ['holdings'], localKeys: 1 }; },
        restore: async (name, password) => { window.calls.restored.push([name, password]); return { createdAt: '', stores: ['holdings'], local: { 'a-stock-radar:notes:v1': '{"notes":["备份里的"]}' } }; },
        relaunch: async () => { window.calls.relaunch += 1; return { ok: true }; }
      };
      window.stockApi = { ...createPreviewApi(), backup };
      function Host() { return React.createElement(BackupSettingsCard, { hidden: false }); }
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
        React.createElement('div', { className: 'app-shell terminal-shell', 'data-workspace': 'settings' },
          React.createElement('div', { className: 'window-dragbar' }, '数据备份界面验证'),
          React.createElement('aside', { className: 'sidebar' }, React.createElement('strong', null, '工作台'), React.createElement('button', { className: 'nav-item active' }, '数据源设置')),
          React.createElement('main', { className: 'main' },
            React.createElement('header', { className: 'topbar' }, '预览'),
            React.createElement('div', { className: 'page' }, React.createElement(Host)),
            React.createElement('footer', { className: 'terminal-statusbar' }, '预览数据')))));
    </script></body></html>`;
    server = await createServer({
      plugins: [{ name: 'backup-fixture', configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/__backup__') return next();
          try { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(request.url, html)); } catch (error) { next(error); }
        });
      } }],
      server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error'
    });
    await server.listen();
    base = `http://127.0.0.1:${server.httpServer.address().port}/__backup__`;
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
    page.setDefaultTimeout(8000);
    try {
      await page.goto(base);
      await page.locator('.backup-settings-card').waitFor();
      await run(page);
      assert.deepEqual(errors, [], 'the renderer must not throw');
    } finally { await page.close(); }
  }

  test('选 iCloud 文件夹、设密码、立即备份；恢复要密码，确认后写回本地数据并重启', async () => {
    await pageTest(async page => {
      const card = page.locator('.backup-settings-card');
      assert.match(await card.innerText(), /还没有选择文件夹/);
      assert.equal(await card.getByRole('button', { name: '立即备份' }).isDisabled(), true);
      await card.getByRole('button', { name: '用iCloud 云盘' }).click();
      await card.getByText('iCloud 云盘 ·').waitFor();
      await card.getByRole('button', { name: '设置密码' }).click();
      await card.getByLabel('备份密码').fill('abc');
      assert.equal(await card.getByRole('button', { name: '保存' }).isDisabled(), true, '少于 6 位不能保存');
      await card.getByLabel('备份密码').fill('abc123');
      await card.getByRole('button', { name: '保存' }).click();
      await card.getByText('已设置，备份会加密').waitFor();
      await card.getByRole('button', { name: '立即备份' }).click();
      await card.getByText('2026-11-12 16:05:09').waitFor();
      const runs = await page.evaluate(() => window.calls.runs);
      assert.deepEqual(Object.keys(runs[0]), ['a-stock-radar:notes:v1'], '只带本软件的本地数据');
      await page.screenshot({ path: path.join(screenshotDir, 'backup.png'), fullPage: true });

      await card.getByRole('button', { name: '从这份恢复' }).click();
      await card.getByLabel('备份密码（恢复）').fill('wrong');
      await card.getByRole('button', { name: '下一步' }).click();
      await card.getByText('备份密码不对').waitFor();
      await card.getByLabel('备份密码（恢复）').fill('abc123');
      await card.getByRole('button', { name: '下一步' }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('button', { name: '恢复并重启' }).click();
      await page.waitForFunction(() => window.calls.relaunch === 1);
      assert.deepEqual(await page.evaluate(() => window.calls.restored), [['A股雷达备份-20261112-160509.json', 'abc123']]);
      assert.equal(await page.evaluate(() => localStorage.getItem('a-stock-radar:notes:v1')), '{"notes":["备份里的"]}');
      assert.equal(await page.evaluate(() => localStorage.getItem('other:key')), 'keep');
    });
  });
});
