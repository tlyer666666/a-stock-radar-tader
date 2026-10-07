'use strict';
// Runs the real React application in an isolated Chrome profile. Only external
// IPC/data boundaries are fixtures. This is NOT a live THS coverage assertion.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright-core');
const root = path.resolve(__dirname, '..');
const artifactRoot = path.join(root, 'artifacts/sector-classification-v144/qa');
const output = path.resolve(process.argv[2] || path.join(artifactRoot, 'latest'));
if (output !== artifactRoot && !output.startsWith(artifactRoot + path.sep)) throw new Error('QA output must remain under artifacts/sector-classification-v144/qa');

const entry = (id, name, level, names, kind = 'classification') => ({ id, code: id.split(':').at(-1), name, level, path: names, kind, classification: '同花顺行业 · 合成 UI 验收数据', sourceUrl: 'https://quant.10jqka.com.cn/view/help/4' });
const rows = [
  entry('qa:level1', '电子', 1, ['电子']),
  entry('qa:level2', '电子化学品', 2, ['电子', '电子化学品']),
  entry('qa:level3', '印制电路板', 3, ['电子', '元件', '印制电路板']),
  entry('qa:glass', '电子化学品Ⅲ', 3, ['电子', '电子化学品', '电子化学品Ⅲ']),
  ...Array.from({ length: 76 }, (_, i) => entry(`qa:leaf${i}`, `验收细分${String(i).padStart(2, '0')}`, 3, ['电子', '验收二级', `验收细分${i}`])),
  entry('qa:tail', '末尾独立细分', 3, ['电子', '验收二级', '末尾独立细分']),
];
const flatRows = [entry('qa:881101', '半导体', null, [], 'industry'), entry('qa:881102', '元件', null, [], 'industry')];
const coverage = count => ({ loaded: count, declared: count, excluded: 0, invalid: 0, pagesLoaded: 1, pagesTotal: 1, complete: false, scope: '合成 UI 验收夹具；不代表真实目录覆盖' });
const catalog = entries => ({ status: 'partial', entries, fetchedAt: '2026-09-30T08:00:00.000Z', asOf: null, sources: [{ name: '合成 UI 验收接口', url: 'https://quant.10jqka.com.cn/view/help/4', status: 'partial', message: '仅验证前端交互' }], warnings: ['QA_SYNTHETIC_WARNING：源资料覆盖未知，请在展开后核对。'], coverage: coverage(entries.length) });
const securities = [
  { code: '603256', name: '宏和科技', secid: '1.603256', assetType: 'stock', thscode: '603256.SH' },
  { code: '300964', name: '本川智能', secid: '0.300964', assetType: 'stock', thscode: '300964.SZ' },
  { code: '600000', name: '浦发银行', secid: '1.600000', assetType: 'stock', thscode: '600000.SH' },
];
const details = Object.fromEntries([...rows, ...flatRows].map(e => [e.id, {
  status: 'partial', entry: e, fetchedAt: '2026-09-30T08:00:00.000Z', asOf: null, reportDate: '2026-06-30',
  members: securities.map((s, i) => ({ ...s, latest: i === 0 ? 12.3 : null, changePercent: i === 0 ? 2.5 : i === 1 ? -1.2 : null, amount: i === 0 ? 2.8e8 : null, turnover: i === 0 ? 1.8 : null })),
  coverage: coverage(3), metrics: null, sources: catalog([]).sources,
  warnings: ['QA_SYNTHETIC_WARNING：源资料覆盖未知，请在展开后核对。'], evidence: [], relatedTerms: [],
}]));
const fixture = { catalog: catalog(rows), flatCatalog: catalog(flatRows), details, classifications: { '603256': catalog([rows[0], rows[1], rows[3]]), '300964': catalog([rows[0], rows[2]]), '600000': catalog([rows[0], rows[1]]) }, securities };
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

// Evaluate computed foreground and its actual stacked solid backgrounds. An
// image/gradient or ancestor opacity is reported as unmeasured, not guessed.
function inspectTypography() {
  const rgba = color => {
    const nums = color.match(/[\d.]+/g)?.map(Number);
    if (!nums || nums.length < 3) throw new Error(`Unsupported computed color ${color}`);
    return [nums[0], nums[1], nums[2], nums[3] ?? 1];
  };
  const composite = (front, back) => [0, 1, 2].map(i => front[i] * front[3] + back[i] * (1 - front[3])).concat(1);
  const luminance = rgb => rgb.slice(0, 3).map(v => { const s = v / 255; return s <= .04045 ? s / 12.92 : ((s + .055) / 1.055) ** 2.4; }).reduce((s, v, i) => s + v * [.2126, .7152, .0722][i], 0);
  const selectors = [
    ['heading', '.sector-explorer h2', 18],
    ['name-input', '#sector-stock-code', 14],
    ['directory-input', '.sector-explorer-toolbar input', 14],
    ['directory-name', '.sector-explorer-entry strong', 14],
    ['directory-meta', '.sector-explorer-entry small', 13],
    ['tab', '.sector-explorer-tabs button', 14],
    ['detail-title', '.sector-explorer-detail-title h3', 18],
    ['date', '.sector-explorer-date span', 13],
    ['status', '.sector-explorer-status', 13],
    ['table-header', '.sector-explorer th', 14],
    ['stock-name', '.sector-explorer td strong', 14],
    ['stock-code', '.sector-explorer td code', 13],
    ['table-number', '.sector-explorer td:nth-child(3)', 14],
    ['candidate', '[role="option"]', 14],
  ];
  const samples = [];
  for (const [label, selector, minimumPx] of selectors) {
    for (const element of [...document.querySelectorAll(selector)].slice(0, 5)) {
      const rect = element.getBoundingClientRect(), css = getComputedStyle(element);
      if (!rect.width || !rect.height || css.visibility !== 'visible' || css.display === 'none') continue;
      let current = element, layers = [], unsupported = [];
      while (current) {
        const layer = getComputedStyle(current);
        if (layer.backgroundImage !== 'none') unsupported.push(`background-image:${current.className}`);
        if (Number(layer.opacity) !== 1) unsupported.push(`opacity:${layer.opacity}`);
        layers.push(rgba(layer.backgroundColor));
        if (layers.at(-1)[3] === 1) break;
        current = current.parentElement;
      }
      const background = layers.reverse().reduce((back, front) => composite(front, back), [255, 255, 255, 1]);
      const foreground = composite(rgba(css.color), background), a = luminance(foreground), b = luminance(background);
      samples.push({ label, text: (element instanceof HTMLInputElement ? element.value || element.placeholder : element.textContent).trim().slice(0, 65), fontSize: parseFloat(css.fontSize), minimumPx, foreground: css.color, effectiveBackground: background.slice(0, 3), ratio: (Math.max(a, b) + .05) / (Math.min(a, b) + .05), unsupported });
      if (element instanceof HTMLInputElement && !element.value) {
        const placeholder = getComputedStyle(element, '::placeholder');
        const color = rgba(placeholder.color); color[3] *= Number(placeholder.opacity);
        const fg = composite(color, background), l = luminance(fg);
        samples.push({ label: `${label}-placeholder`, text: element.placeholder, fontSize: parseFloat(placeholder.fontSize || css.fontSize), minimumPx, foreground: placeholder.color, effectiveBackground: background.slice(0, 3), ratio: (Math.max(l, b) + .05) / (Math.min(l, b) + .05), unsupported });
      }
    }
  }
  return samples;
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const startedAt = new Date().toISOString();
  const sourceFiles = ['src/App.tsx', 'src/previewApi.ts', 'src/SectorExplorerPanel.tsx', 'src/sector-explorer.css', 'src/styles.css', 'src/terminal-ui.css', 'src/terminal-research.css', 'src/workbench.css', 'src/sectorExplorerTypes.ts', 'qa/run-sector-v144-smoke.cjs'];
  const sourceHashes = Object.fromEntries(sourceFiles.map(f => [f, hash(fs.readFileSync(path.join(root, f)))]));
  const baselineDir = process.env.QA_BASELINE_DIR && path.resolve(process.env.QA_BASELINE_DIR);
  if (baselineDir && !baselineDir.startsWith(artifactRoot + path.sep)) throw new Error('Baseline must remain in the QA artifact directory');
  const overrides = baselineDir ? ['src/SectorExplorerPanel.tsx', 'src/sector-explorer.css', 'src/sectorExplorerTypes.ts'] : [];
  const servedOverrides = Object.fromEntries(overrides.map(f => [f, hash(fs.readFileSync(path.join(baselineDir, f)))]));
  const results = [], errors = [], contexts = [], unexpectedRequests = [];
  let server, browser, inspectedPage;
  let baseUrl = baselineDir ? undefined : process.env.QA_BASE_URL;
  try {
    if (!baseUrl) {
      const { createServer } = await import('vite');
      const plugins = baselineDir ? [{ name: 'qa-readonly-release-baseline', enforce: 'pre', load(id) {
        const rel = path.relative(root, id.split('?')[0]);
        if (overrides.includes(rel)) return fs.readFileSync(path.join(baselineDir, rel), 'utf8');
      } }] : [];
      server = await createServer({ root, plugins, server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'warn' });
      await server.listen();
      baseUrl = `http://127.0.0.1:${server.httpServer.address().port}`;
    }
    browser = await chromium.launch({ executablePath: process.env.QA_CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true });
    async function createPage(flat = false) {
      const context = await browser.newContext({ viewport: { width: 1480, height: 1050 }, locale: 'zh-CN', colorScheme: 'dark' });
      contexts.push(context);
      await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin === new URL(baseUrl).origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
        unexpectedRequests.push({ origin: url.origin, pathname: url.pathname });
        return route.abort();
      });
      const page = await context.newPage();
      inspectedPage = page;
      page.setDefaultTimeout(3500);
      page.on('pageerror', e => errors.push(e.message));
      await page.goto(baseUrl, { waitUntil: 'networkidle' });
      await page.evaluate(({ f, flat }) => {
        const clone = value => structuredClone(value);
        const qa = window.__sectorQA = { calls: [], cancelled: [], held: {}, release: {}, flat };
        const wait = async key => { if (qa.held[key]) await new Promise(resolve => { qa.release[key] = resolve; }); };
        window.stockApi.getSectorCatalog = async options => { qa.calls.push({ method: 'catalog', options }); return clone(flat ? f.flatCatalog : f.catalog); };
        window.stockApi.getSectorDetail = async options => { qa.calls.push({ method: 'detail', options }); await wait(`detail:${options.id}`); if (!f.details[options.id]) throw new Error('Unexpected fixture detail id'); return clone(f.details[options.id]); };
        window.stockApi.getSectorClassifications = async options => { qa.calls.push({ method: 'classification', options }); await wait(`classification:${options.code}`); if (!f.classifications[options.code]) throw new Error('Unexpected fixture security'); return clone(f.classifications[options.code]); };
        window.stockApi.cancelSectorRequest = async id => { qa.cancelled.push(id); return { cancelled: true }; };
        window.stockApi.search = async query => {
          qa.calls.push({ method: 'search', query }); await wait(`search:${query}`);
          if (query === '宏和' || query === '宏和科技') return clone([f.securities[0], { ...f.securities[2], name: '宏和候选银行' }, { ...f.securities[1], name: '*ST 验收' }, { ...f.securities[2], assetType: 'index', name: '宏和指数' }]);
          if (query === '本川' || query === '本川智能') return clone([f.securities[1]]);
          return clone(f.securities.filter(s => s.code === query || s.name.includes(query)));
        };
        window.stockApi.openExternal = async url => { qa.lastExternal = url; };
      }, { f: fixture, flat });
      await page.getByRole('button', { name: '板块强度', exact: true }).click();
      await page.locator('.sector-explorer').waitFor();
      await page.waitForFunction(() => window.__sectorQA.calls.some(x => x.method === 'catalog'));
      await page.waitForTimeout(40);
      return page;
    }
    async function check(name, fn) {
      const at = Date.now();
      try { const evidence = await fn(); results.push({ name, passed: true, durationMs: Date.now() - at, evidence }); }
      catch (error) {
        const diagnostic = inspectedPage && await inspectedPage.evaluate(() => ({ url: location.href, title: document.title, panelPresent: Boolean(document.querySelector('.sector-explorer')), visibleText: document.body.innerText.slice(0, 3000) })).catch(() => null);
        await inspectedPage?.screenshot({ path: path.join(output, `failure-${results.length + 1}.png`), fullPage: true }).catch(() => {});
        results.push({ name, passed: false, durationMs: Date.now() - at, error: error.message, diagnostic });
      }
      console.log(`${results.at(-1).passed ? 'PASS' : 'FAIL'} ${name}${results.at(-1).passed ? '' : ': ' + results.at(-1).error.split('\n')[0]}`);
    }
    async function pickDetail(page, name = '印制电路板') {
      await page.getByLabel('搜索细分板块').fill(name);
      await page.locator('.sector-explorer-entry').filter({ hasText: name }).first().click();
      await page.locator('.sector-explorer-detail h3').filter({ hasText: name }).waitFor();
    }
    const flat = await createPage(true);
    await check('available flat directory is visible by default', async () => {
      const count = await flat.locator('.sector-explorer-entry').count();
      assert.equal(count, 2, 'default filter hides valid catalog when L2/L3 are absent');
      return { visibleEntries: count, liveCoverageClaim: false };
    });
    await flat.screenshot({ path: path.join(output, 'default-flat-catalog.png'), fullPage: true });
    await check('classification empty state directs user to name lookup', async () => {
      await flat.getByRole('button', { name: '行业分类', exact: true }).click();
      await flat.getByRole('button', { name: '输入股票名称查询行业分类', exact: true }).click();
      assert.equal(await flat.evaluate(() => document.activeElement.id), 'sector-stock-code');
    });
    await check('refreshing public catalog preserves separately discovered classifications', async () => {
      await flat.locator('#sector-stock-code').fill('603256');
      await flat.locator('.sector-explorer-discover').getByRole('button', { name: '查行业', exact: true }).click();
      await flat.locator('.sector-explorer-detail h3').filter({ hasText: '电子化学品Ⅲ' }).waitFor();
      await flat.getByRole('button', { name: '刷新目录', exact: true }).click();
      await flat.waitForFunction(() => !document.querySelector('.sector-explorer-actions button')?.disabled);
      assert.equal(await flat.locator('.sector-explorer-entry').filter({ hasText: '电子化学品Ⅲ' }).count(), 1, 'public refresh must not erase a separately discovered industry');
      assert.equal(await flat.locator('.sector-explorer-detail h3').innerText(), '电子化学品Ⅲ');
    });
    const page = await createPage();
    await check('Chinese name resolves eligible candidates and selected stock industry', async () => {
      await page.locator('#sector-stock-code').fill('宏和');
      await page.getByRole('option', { name: /宏和科技/ }).waitFor();
      assert.equal(await page.getByRole('option').count(), 2, 'exclude ST and index candidates');
      await page.getByRole('option', { name: /宏和科技/ }).click();
      await page.locator('.sector-explorer-discover').getByRole('button', { name: '查行业', exact: true }).click();
      await page.locator('.sector-explorer-detail h3').filter({ hasText: '电子化学品Ⅲ' }).waitFor();
      return { selectedCode: '603256', expectedIndustry: '电子化学品Ⅲ' };
    });
    await check('six digit code remains compatible', async () => {
      await page.locator('#sector-stock-code').fill('300964');
      await page.locator('.sector-explorer-discover').getByRole('button', { name: '查行业', exact: true }).click();
      await page.locator('.sector-explorer-detail h3').filter({ hasText: '印制电路板' }).waitFor();
    });
    await check('directory search sees a node beyond initial render limit', async () => {
      await page.getByLabel('搜索细分板块').fill('末尾独立细分');
      assert.equal(await page.locator('.sector-explorer-entry').count(), 1);
      assert.match(await page.locator('.sector-explorer-entry').innerText(), /末尾独立细分/);
    });
    await check('late name result cannot replace newer query', async () => {
      await page.evaluate(() => { window.__sectorQA.held['search:宏和'] = true; });
      await page.locator('#sector-stock-code').fill('宏和');
      await page.waitForFunction(() => Boolean(window.__sectorQA.release['search:宏和']));
      await page.locator('#sector-stock-code').fill('本川');
      await page.getByRole('option', { name: /本川智能/ }).waitFor();
      await page.evaluate(() => { window.__sectorQA.release['search:宏和'](); window.__sectorQA.held['search:宏和'] = false; });
      await page.waitForTimeout(80);
      assert.match(await page.getByRole('option').allTextContents().then(x => x.join('|')), /本川智能/);
      assert.equal(await page.getByRole('option', { name: /宏和/ }).count(), 0);
      assert.equal(await page.locator('#sector-stock-code').inputValue(), '本川');
    });
    await check('late classification cannot replace manual navigation', async () => {
      await page.evaluate(() => { window.__sectorQA.held['classification:300964'] = true; });
      await page.locator('#sector-stock-code').fill('300964');
      await page.locator('.sector-explorer-discover').getByRole('button', { name: '查行业', exact: true }).click();
      await page.waitForFunction(() => Boolean(window.__sectorQA.release['classification:300964']));
      await pickDetail(page, '末尾独立细分');
      await page.evaluate(() => { window.__sectorQA.release['classification:300964'](); window.__sectorQA.held['classification:300964'] = false; });
      await page.waitForTimeout(80);
      assert.equal(await page.locator('.sector-explorer-detail h3').innerText(), '末尾独立细分');
    });
    await check('IME composition waits before search and keyboard selects a candidate', async () => {
      const input = page.locator('#sector-stock-code');
      await input.fill('');
      await page.evaluate(() => { window.__sectorQA.calls = []; });
      await input.dispatchEvent('compositionstart', { data: '' });
      await input.fill('宏');
      await page.waitForTimeout(320);
      assert.equal(await page.evaluate(() => window.__sectorQA.calls.filter(x => x.method === 'search' && x.query === '宏').length), 0, 'incomplete Chinese composition should not issue a search');
      await input.fill('宏和');
      await input.dispatchEvent('compositionend', { data: '宏和' });
      await page.getByRole('option', { name: /宏和科技/ }).waitFor();
      await input.press('ArrowDown');
      await input.press('Enter');
      assert.match(await input.inputValue(), /宏和科技.*603256/);
      assert.equal(await page.getByRole('option').count(), 0);
      await page.locator('.sector-explorer-discover').getByRole('button', { name: '查行业', exact: true }).click();
      await page.locator('.sector-explorer-detail h3').filter({ hasText: '电子化学品Ⅲ' }).waitFor();
    });
    await check('editing stock intent discards an already running classification', async () => {
      await pickDetail(page, '末尾独立细分');
      await page.evaluate(() => { window.__sectorQA.held['classification:300964'] = true; delete window.__sectorQA.release['classification:300964']; });
      await page.locator('#sector-stock-code').fill('300964');
      await page.locator('.sector-explorer-discover').getByRole('button', { name: '查行业', exact: true }).click();
      await page.waitForFunction(() => Boolean(window.__sectorQA.release['classification:300964']));
      await page.locator('#sector-stock-code').fill('本川');
      await page.evaluate(() => { window.__sectorQA.release['classification:300964'](); window.__sectorQA.held['classification:300964'] = false; });
      await page.waitForTimeout(80);
      assert.equal(await page.locator('.sector-explorer-detail h3').innerText(), '末尾独立细分');
      assert.equal(await page.locator('#sector-stock-code').inputValue(), '本川');
    });
    await check('essential state stays visible but verbose provenance is collapsed', async () => {
      await pickDetail(page);
      const text = await page.locator('.sector-explorer').innerText();
      assert.doesNotMatch(text, /QA_SYNTHETIC_WARNING|核对分类、成分与来源|从任意 A 股发现|不代表完整行业树|人工整理的产业链研究/);
      assert.match(text, /部分资料/);
      assert.match(text, /未提供|未标明|未知/);
      const disclosure = page.locator('.sector-explorer-data-details');
      assert.equal(await disclosure.count(), 1, 'detail provenance must remain accessible in disclosure');
      assert.equal(await disclosure.getAttribute('open'), null);
      await disclosure.locator('summary').click();
      assert.match(await disclosure.innerText(), /QA_SYNTHETIC_WARNING/);
      await disclosure.locator('summary').click();
    });
    for (const theme of ['dark', 'light']) for (const width of [760, 1024, 1480]) {
      await check(`layout and computed typography ${width} ${theme}`, async () => {
        await page.setViewportSize({ width, height: 1050 });
        await page.getByRole('button', { name: theme === 'light' ? /^(白天|白昼)$/ : /^(黑夜|暮夜)$/ }).click();
        await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
        await page.getByLabel('搜索细分板块').fill('');
        await page.locator('#sector-stock-code').fill('');
        await page.locator('.main > .page').evaluate(e => e.scrollTo(0, 0));
        await page.waitForTimeout(30);
        const layout = await page.evaluate(() => ({
          viewport: innerWidth, documentWidth: document.documentElement.scrollWidth,
          bodyWidth: document.body.scrollWidth,
          panelWidth: document.querySelector('.sector-explorer').clientWidth,
          panelScrollWidth: document.querySelector('.sector-explorer').scrollWidth,
          mainWidth: document.querySelector('.main').clientWidth,
          mainScrollWidth: document.querySelector('.main').scrollWidth,
        }));
        const samples = await page.evaluate(inspectTypography);
        fs.writeFileSync(path.join(output, `typography-${width}-${theme}.json`), JSON.stringify({ layout, samples }, null, 2));
        await page.screenshot({ path: path.join(output, `sector-${width}-${theme}.png`), fullPage: true });
        assert.ok(layout.documentWidth <= width + 2 && layout.bodyWidth <= width + 2 && layout.mainScrollWidth <= layout.mainWidth + 2 && layout.panelScrollWidth <= layout.panelWidth + 2, `horizontal overflow ${JSON.stringify(layout)}`);
        assert.ok(samples.length >= 20, 'not enough actual rendered text samples');
        const unsupported = samples.filter(s => s.unsupported.length);
        assert.deepEqual(unsupported, [], 'background requires separate pixel verification; no guessed contrast');
        const lowContrast = samples.filter(s => s.ratio < 4.5);
        assert.deepEqual(lowContrast.map(s => ({ label: s.label, ratio: s.ratio, text: s.text })), [], 'normal body text contrast below 4.5');
        const small = samples.filter(s => s.fontSize < s.minimumPx);
        assert.deepEqual(small.map(s => ({ label: s.label, size: s.fontSize, minimum: s.minimumPx })), [], 'body or supporting labels are too small');
        return { layout, measured: samples.length, minimumContrast: Math.min(...samples.map(s => s.ratio)), minimumFontPx: Math.min(...samples.map(s => s.fontSize)) };
      });
    }
    for (const theme of ['dark', 'light']) await check(`candidate popup and hover contrast ${theme}`, async () => {
      await page.setViewportSize({ width: 1024, height: 1050 });
      await page.getByRole('button', { name: theme === 'light' ? /^(白天|白昼)$/ : /^(黑夜|暮夜)$/ }).click();
      await page.waitForFunction(value => document.documentElement.dataset.theme === value, theme);
      await page.locator('#sector-stock-code').fill('宏和');
      await page.getByRole('option', { name: /宏和科技/ }).waitFor();
      await page.getByRole('option', { name: /宏和科技/ }).hover();
      const candidates = (await page.evaluate(inspectTypography)).filter(s => s.label === 'candidate');
      assert.equal(candidates.length, 2);
      assert.deepEqual(candidates.filter(s => s.ratio < 4.5 || s.fontSize < 14 || s.unsupported.length), []);
      await page.screenshot({ path: path.join(output, `candidates-${theme}.png`), fullPage: true });
      await page.locator('#sector-stock-code').press('Escape');
      assert.equal(await page.getByRole('option').count(), 0);
      await page.locator('.sector-explorer-entry').first().hover();
      const hovered = (await page.evaluate(inspectTypography)).filter(s => s.label === 'directory-name').slice(0, 1);
      assert.equal(hovered.length, 1);
      assert.deepEqual(hovered.filter(s => s.ratio < 4.5 || s.fontSize < 14 || s.unsupported.length), []);
      return { candidates, hovered };
    });
    await check('no renderer exceptions or external data calls', async () => { assert.deepEqual(errors, []); assert.deepEqual(unexpectedRequests, []); });
  } finally {
    for (const context of contexts) await context.close().catch(() => {});
    await browser?.close();
    await server?.close();
    const drift = sourceFiles.filter(f => sourceHashes[f] !== hash(fs.readFileSync(path.join(root, f))));
    const result = { startedAt, finishedAt: new Date().toISOString(), mode: 'Real Chrome + real React; isolated synthetic IPC data fixtures, no live THS data or complete-directory claim', baseUrl, browser: browser?.version(), passed: results.length > 0 && results.every(x => x.passed) && errors.length === 0, baselineDir, servedOverrides, sourceHashes, sourceDrift: drift, fixtureSha256: hash(JSON.stringify(fixture)), cases: results, pageErrors: errors, blockedExternalRequests: unexpectedRequests, limitations: ['Does not prove live THS directory completeness, data freshness or server-side search correctness.', 'Contrast uses computed solid-background compositing; unsupported images/opacity fail rather than being guessed.', 'Screenshots require human visual review in addition to geometry checks.'] };
    if (drift.length) result.passed = false;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
    if (!result.passed) process.exitCode = 1;
    console.log(`Report: ${path.join(output, 'result.json')}`);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
