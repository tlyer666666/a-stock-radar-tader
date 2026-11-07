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
    const selectionDefinitions = require('../electron/strategy-signal-engine.cjs').STRATEGY_DEFINITIONS;
    const styles = [...main.matchAll(/import\s+["']\.\/([^"']+\.css)["']/g)].map(match => `import '/src/${match[1]}';`).join('\n');
    const html = `<!doctype html><html data-theme="dark"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
      import React from 'react'; import { createRoot } from 'react-dom/client';
      import TrendScreenerView from '/src/TrendScreenerView.tsx';
      import StrategySignalsView from '/src/StrategySignalsView.tsx';
      import { createPreviewApi } from '/src/previewApi.ts';
      ${styles}
      window.stockApi = createPreviewApi(); window.calls = { opened: [], backtests: [] };
      const signals = new URLSearchParams(location.search).get('view') === 'signals';
      if (signals) {
        const definitions = ${JSON.stringify(selectionDefinitions)};
        const previewSelection = window.stockApi.scanStrategySignals;
        window.stockApi.getStrategyDefinitions = async () => structuredClone(definitions);
        window.stockApi.scanStrategySignals = async options => {
          const preview = await previewSelection(options);
          const byId = new Map(preview.strategies.map(group => [group.id, group]));
          const report = { ...preview, generatedAt: '2026-10-21T02:00:00Z', asOfDate: '2026-10-20',
            universeCoverage: { boards: [], failed: 0, requestsComplete: true, complete: true },
            dataQuality: { requested: preview.universeSize, processed: preview.processed, invalid: 0, stale: 0, missing: 0,
              excluded: 0, benchmarkReady: true, calendarState: 'ready', reasons: {} },
            strategies: definitions.map(definition => ({ ...definition,
              stocks: (byId.get(definition.id)?.stocks || []).map(stock => ({ ...stock, signalDate: '2026-10-20' })) })) };
          window.selectionFixture = structuredClone(report);
          return report;
        };
      }
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
      // The preview API starts with no scan; row interaction/layout checks need seeded results.
      if (view === 'trend' && !(await page.locator('.trend-result-row:visible').count())) {
        await page.locator('.trend-header-actions').getByRole('button', { name: '扫描全 A 股', exact: true }).click();
        await page.locator('.trend-result-row:visible').first().waitFor();
      }
      await body(page); assert.deepEqual(errors, [], 'no renderer exception during research interactions');
    } finally { await page.close(); }
  }

  // D2-07a：原用例名是「expand without remounting a calculator」，断言详情卡里的
  // DOM 标记（data-mount-marker）在收起 / 切筛选 / 切标签后仍然存在。
  // 但自紧凑结果表改版（v1.5.3 基线起）详情是 <tr class="trend-result-details">，
  // 由 {expanded && ...} 条件渲染：一收起身，整棵子树就从 DOM 移除，
  // 重新展开必然是新的 DOM 节点 —— 该标记断言在产品设计上不可能成立，
  // 属于「断言过期」，不是草稿丢失的回归。
  // 真正要守的契约是「草稿与测算器展开状态不丢」，以及「状态刷新不得重挂载已展开的测算器」，
  // 因此改为：刷新扫描状态时校验 DOM 节点未变（标记保留）+ 收起重开后校验草稿被重新水合。
  test('candidate rows keep an unsaved draft and a live calculator across filters, tabs and status refresh', () => run('trend', async page => {
    assert.equal(await page.locator('.trend-result-table').count(), 1, 'candidates use a compact result table');
    assert.equal(await page.locator('.trend-candidate, .trend-result-details .trend-calculator').count(), 0, 'unopened candidates do not render full cards or calculators');
    const row = page.locator('.trend-result-row').first();
    await row.getByRole('button', { name: /详情/ }).click();
    const card = page.locator('.trend-result-details:visible .trend-candidate').first();
    await card.locator('.trend-calculator > summary').click();
    const nav = card.getByRole('spinbutton', { name: '账户净资产', exact: true });
    await nav.fill('123456');
    await nav.evaluate(element => { element.dataset.mountMarker = 'original'; });
    // 行保持展开时刷新扫描状态：候选数据整体替换，但同一只股票的 key 不变，
    // 因此测算器不得被重挂载（DOM 节点身份保留），草稿也不得丢。
    await page.getByRole('button', { name: '刷新扫描状态' }).click();
    await page.waitForTimeout(300);
    assert.equal(await nav.getAttribute('data-mount-marker'), 'original', '刷新扫描状态不得重挂载已展开的计划测算器');
    assert.equal(await nav.inputValue(), '123456', '刷新扫描状态不得丢失未保存的账户净资产草稿');
    await row.getByRole('button', { name: /收起/ }).click();
    assert.equal(await card.isVisible(), false);
    assert.equal(await page.locator('.trend-result-details').count(), 0, '收起后详情行按需卸载');
    await page.getByRole('textbox', { name: '搜索代码或名称' }).fill('不存在');
    await page.getByRole('textbox', { name: '搜索代码或名称' }).fill('');
    await page.getByRole('button', { name: /^我的计划/ }).click();
    await page.getByRole('button', { name: /^研究候选/ }).click();
    await row.getByRole('button', { name: /详情/ }).click();
    // 收起/重开会新建 DOM，所以这里校验「草稿被重新水合」：数值与测算器展开状态都要恢复。
    assert.equal(await nav.inputValue(), '123456');
    assert.equal(await card.locator('.trend-calculator').evaluate(element => element.open), true, '重新展开后测算器应保持展开');
    await card.getByRole('button', { name: '加入我的计划', exact: true }).click();
    await page.getByRole('button', { name: /^我的计划/ }).click();
    // 候选行与计划行共用同一份行工作区（rowWorkspaces 按计划 id 命中），
    // 所以切到「我的计划」时这一行通常已经带着候选页的展开状态，按钮是「收起」。
    // 原断言假定这里一定是收起状态、必须先点「详情」，属于过期假设；
    // 这里两种状态都归一到「展开」，不再要求行必须是收起的。
    const planRow = page.locator('.trend-result-row:visible').first();
    await planRow.waitFor();
    if (!(await planRow.getByRole('button', { name: /^收起/ }).count())) await planRow.getByRole('button', { name: /^详情/ }).click();
    const saved = page.locator('.trend-result-details:visible .trend-candidate').first();
    await saved.waitFor();
    const savedCalculator = saved.locator('.trend-calculator').first();
    // 测算器的展开状态同样保存在行工作区里：已展开时再点 summary 反而会把它收起。
    if (!(await savedCalculator.evaluate(element => element.open))) await savedCalculator.locator('summary').click();
    assert.equal(await saved.getByRole('spinbutton', { name: '账户净资产', exact: true }).inputValue(), '123456');
    assert.match(await saved.locator('.trend-snapshot-notice').innerText(), /历史快照/);
    const download = page.waitForEvent('download');
    await page.getByRole('button', { name: '导出计划 CSV' }).click();
    assert.match((await download).suggestedFilename(), /我的计划.*\.csv$/);
    await saved.getByRole('button', { name: /^移除/ }).click();
    assert.equal(await page.locator('.trend-result-row:visible').count(), 0);
  }));

  async function realExecutionCard(page, withApi) {
    await page.clock.install({ time: new Date('2026-10-21T01:30:00Z') });
    await page.evaluate(async withApi => {
      const status = await window.stockApi.getTrendScan();
      status.isPreview = false; status.marketGate = 'open'; status.asOf = '2026-10-20';
      status.freshness = { state: 'current', actualDate: status.asOf, expectedDate: status.asOf, reason: 'fixture current session' };
      status.candidates = [status.candidates[0]];
      status.candidates[0].asOf = status.asOf;
      status.candidates[0].metrics.medianAmount20 = 300000000;
      window.stockApi.getTrendScan = async () => status;
      if (withApi) window.stockApi.checkTrendExecution = async request => ({
        checkedAt: new Date().toISOString(), quoteAt: new Date().toISOString(), signalDate: request.signalDate, expectedSignalDate: request.signalDate,
        executionDate: '2026-10-21', state: 'ready', reasons: [], latest: 12.3, upperLimit: 13.5, lowerLimit: 11,
        suspended: false, priceDate: '2026-10-21', source: '公开行情（测试）', minimumBuyQuantity: 100, quantityStep: 100,
        validUntil: new Date(Date.now() + 60000).toISOString()
      });
      else delete window.stockApi.checkTrendExecution;
    }, withApi);
    await page.getByRole('button', { name: '刷新扫描状态' }).click();
    await page.locator('.trend-result-row:visible').first().getByRole('button', { name: /详情/ }).click();
    const card = page.locator('.trend-result-details:visible .trend-candidate').first();
    await card.locator('.trend-calculator > summary').click();
    return card;
  }

  test('missing execution API blocks current plans without crashing older runtimes', () => run('trend', async page => {
    const card = await realExecutionCard(page, false);
    await card.getByRole('button', { name: '刷新执行检查', exact: true }).click();
    assert.match(await card.locator('.trend-execution-check').innerText(), /未知|不支持/);
    assert.equal(await card.getByRole('checkbox', { name: /本快照仍为上一交易日/ }).count(), 0, 'old manual session checkbox cannot bypass calendar checks');
    assert.equal(await page.locator('.trend-result-row:visible').count(), 1, 'execution unknown never hides rule matches');
  }));

  test('current execution, cost assumptions and board rules permit sizing only until the check expires', () => run('trend', async page => {
    const card = await realExecutionCard(page, true);
    for (const [name, value] of [['账户净资产','1000000'], ['拟成交价 P','12.3'], ['可用现金','1000000'], ['已有同业仓位','0'], ['已有总仓位','0'], ['已有持仓数量','0'], ['预留费用','0'], ['组合已占用风险','0']]) {
      await card.getByRole('spinbutton', { name, exact: true }).fill(value);
    }
    for (const name of [/已核实板块权限/, /已复核最新公告/, /已确认价格、止损/, /已核对费用与滑点/]) await card.getByRole('checkbox', { name }).check();
    await card.getByRole('button', { name: '计算参考股数', exact: true }).click();
    assert.match(await card.locator('.trend-calculation-result').innerText(), /暂不生成可执行仓位/);
    await card.getByRole('button', { name: '刷新执行检查', exact: true }).click();
    await card.getByRole('button', { name: '计算参考股数', exact: true }).click();
    assert.match(await card.locator('.trend-calculation-result').innerText(), /满足当前输入下的计划约束/);
    assert.match(await card.locator('.trend-sizing-values').innerText(), /压力亏损|双边费用/);
    await page.clock.fastForward(61000);
    assert.match(await card.locator('.trend-calculation-result').innerText(), /暂不生成可执行仓位/);
    assert.match(await card.locator('.trend-execution-check').innerText(), /过期/);
  }));

  test('late execution results cannot unlock a replacement candidate and expiry sends no automatic quote request', () => run('trend', async page => {
    const card = await realExecutionCard(page, true);
    await page.evaluate(() => {
      window.executionCalls = 0;
      window.stockApi.checkTrendExecution = request => { window.executionCalls++; return new Promise(resolve => { window.resolveExecution = () => resolve({
        checkedAt: new Date().toISOString(), quoteAt: new Date().toISOString(), signalDate: request.signalDate, expectedSignalDate: request.signalDate,
        executionDate: '2026-10-21', state: 'ready', reasons: [], latest: 12.3, upperLimit: 13.5, lowerLimit: 11,
        suspended: false, priceDate: '2026-10-21', source: '公开测试行情', minimumBuyQuantity: 100, quantityStep: 100
      }); }); };
    });
    await card.getByRole('button', { name: '刷新执行检查', exact: true }).click();
    await page.evaluate(async () => {
      const status = structuredClone(await window.stockApi.getTrendScan());
      status.candidates[0].security = { ...status.candidates[0].security, secid: '1.600999', code: '600999', name: '替换候选' };
      window.stockApi.getTrendScan = async () => structuredClone(status);
    });
    await page.getByRole('button', { name: '刷新扫描状态' }).click();
    await page.locator('.trend-result-row:visible').first().getByRole('button', { name: /详情/ }).click();
    const replacement = page.locator('.trend-result-details:visible .trend-candidate').first();
    await replacement.locator('.trend-calculator > summary').click();
    await page.evaluate(() => window.resolveExecution());
    assert.match(await replacement.locator('.trend-execution-check').innerText(), /未知/);
    await page.clock.fastForward(61000);
    assert.equal(await page.evaluate(() => window.executionCalls), 1);
  }));

  test('quote age expires readiness before a later check timestamp', () => run('trend', async page => {
    const card = await realExecutionCard(page, true);
    await page.evaluate(() => {
      const original = window.stockApi.checkTrendExecution;
      window.stockApi.checkTrendExecution = async request => ({ ...await original(request), quoteAt: new Date(Date.now() - 30000).toISOString() });
    });
    await card.getByRole('button', { name: '刷新执行检查', exact: true }).click();
    assert.match(await card.locator('.trend-execution-check').innerText(), /当前可复核/);
    await page.clock.fastForward(31000);
    assert.match(await card.locator('.trend-execution-check').innerText(), /已过期/);
  }));

  test('custom research scans require a reason and export their frozen attempt journal', () => run('trend', async page => {
    const config = page.locator('.trend-scan-configuration');
    await config.locator(':scope > summary').click();
    await config.locator('.trend-quality-parameters > summary').click();
    await config.locator('.trend-quality-parameters input').first().fill('1.7');
    await page.locator('.trend-header-actions').getByRole('button', { name: '扫描全 A 股', exact: true }).click();
    assert.match(await page.locator('.trend-error').first().innerText(), /原因/);
    assert.notEqual(await config.locator('.trend-scan-journal').getAttribute('open'), null, 'validation opens the reason field for correction');
    await config.getByRole('textbox', { name: '扫描 / 调参原因' }).fill('预登记敏感性研究');
    await config.getByLabel('研究起始', { exact: true }).fill('2025-01-01');
    await config.getByLabel('研究截止', { exact: true }).fill('2026-10-20');
    await page.locator('.trend-header-actions').getByRole('button', { name: '扫描全 A 股', exact: true }).click();
    await page.waitForFunction(() => JSON.parse(localStorage.getItem('a-stock-radar:trend-scan-journal:v1')).entries.some(entry => entry.reason === '预登记敏感性研究'));
    const rows = await page.evaluate(() => JSON.parse(localStorage.getItem('a-stock-radar:trend-scan-journal:v1')).entries);
    assert.equal(rows[0].range.start, '2025-01-01');
    assert.equal(rows[0].request.strategies.find(item => item.strategyId === 'quality-v2').config.maxExtensionAtr, 1.7);
    assert.match(rows[0].parameterHash, /^[a-f0-9]{64}$/);
    const download = page.waitForEvent('download');
    await config.getByRole('button', { name: '导出扫描日志 CSV', exact: true }).click();
    assert.match((await download).suggestedFilename(), /日志.*\.csv$/);
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
    await config.locator('.trend-advanced-models > summary').click();
    await config.getByRole('textbox', { name: '查找趋势策略' }).fill('MACD');
    assert.ok(await config.locator('.trend-library-choice').count() > 0);
    await config.getByRole('button', { name: '单模型扫描', exact: true }).click();
    assert.equal(await config.getByRole('combobox', { name: '扫描策略', exact: true }).isVisible(), true);
    await config.locator('.trend-library-reference > summary').click();
    assert.equal(await config.locator('.trend-library-reference a:visible').count(), library.reduce((count, strategy) => count + strategy.sources.length, 0));
  }));

  // 1.6.52 起默认隐藏本轮无结果的策略；数策略个数的用例先显示全部。
  async function showEmptyStrategies(page) {
    const box = page.locator('.signal-hide-empty input');
    if (await box.count() && await box.isChecked()) await box.uncheck();
  }

  test('signal module displays selected stocks without validation, backtest or analysis controls', () => run('signals', async page => {
    await page.locator('.strategy-stock-panel tbody tr').first().waitFor();
    await showEmptyStrategies(page);
    const content = await page.locator('.strategy-signals-view').innerText();
    assert.doesNotMatch(content, /回测|复盘|验证|观察中|指定股票测试|样本外|走步/);
    const definitionCount = await page.evaluate(async () => (await window.stockApi.getStrategyDefinitions()).length);
    assert.equal(await page.locator('.strategy-signal-tab-list > button').count(), definitionCount);
    // 1.5.5 起股票名称是进入个股分析的唯一按钮；行内不应再有验证、回测等其他操作。
    // 迷你 K 线（点开看大图）是看图，不是验证或回测操作。
    const extra = await page.locator('.strategy-stock-panel tbody tr').first().locator('button:not(.strategy-security-link):not(.selection-kline-trigger), details').evaluateAll(nodes => nodes.map(node => node.outerHTML.slice(0, 200)));
    assert.deepEqual(extra, []);
    const calls = await page.evaluate(() => window.calls);
    assert.deepEqual(calls, { opened: [], backtests: [] });
    const search = page.getByRole('textbox', { name: '搜索信号策略' });
    await search.fill('不存在'); assert.equal(await page.locator('.strategy-signal-tab-list > button').count(), 0);
    await search.fill(''); assert.equal(await page.locator('.strategy-signal-tab-list > button').count(), definitionCount);
    await page.getByRole('combobox', { name: '策略排序' }).selectOption('picks');
    await page.getByRole('button', { name: '重新选股', exact: true }).click();
    await page.getByRole('button', { name: '重新选股', exact: true }).waitFor();
    assert.ok(await page.locator('.strategy-stock-panel tbody tr').count() > 0);
  }));

  test('signal families switch the stock view and keep the selection rules collapsed until requested', () => run('signals', async page => {
    await page.locator('.strategy-stock-panel tbody tr').first().waitFor();
    await showEmptyStrategies(page);
    // 家族下拉只列在用策略里还有的家族（游资打法整族下线后不再出现）。
    const familyIds = await page.getByRole('combobox', { name: '策略家族', exact: true }).locator('option').evaluateAll(options => options.map(option => option.value));
    const liveFamilies = await page.evaluate(async () => [...new Set((await window.stockApi.getStrategyDefinitions()).map(group => group.family))]);
    assert.ok(familyIds.length > 2 && familyIds.filter(id => id !== 'all').every(id => liveFamilies.includes(id)), JSON.stringify({ familyIds, liveFamilies }));
    assert.ok(!familyIds.includes('youzi'), 'retired-only families are not offered');
    const family = page.getByRole('combobox', { name: '策略家族', exact: true });
    await family.selectOption('pullback');
    const expected = await page.evaluate(async () => (await window.stockApi.getStrategyDefinitions()).filter(group => group.family === 'pullback').length);
    assert.equal(await page.locator('.strategy-signal-tab-list > button').count(), expected);
    assert.ok(expected > 0);
    assert.match(await page.locator('.strategy-signal-group-head').innerText(), /回踩|回收|回调|均线|缺口|动能|支撑/);
    const rules = page.locator('.signal-rule-details');
    assert.equal(await rules.getAttribute('open'), null);
    assert.match(await page.locator('.strategy-stock-panel').innerText(), /排序分[^\n]*(不是胜率|非胜率)/);
    assert.equal(await page.locator('.strategy-stock-panel button, .strategy-stock-panel details').filter({ hasText: /回测|分析|发订单/ }).count(), 0);
    await rules.locator(':scope > summary').click();
    assert.match(await rules.innerText(), /必要条件|数据要求|筛选范围/);
    await rules.locator(':scope > summary').click();
    await family.selectOption('all');
    assert.equal(await page.locator('.strategy-signal-tab-list > button').count(), await page.evaluate(async () => (await window.stockApi.getStrategyDefinitions()).length));
    const note = await page.locator('.strategy-method-note').innerText();
    assert.match(note, /数据日：2026-10-20/);
    assert.match(note, /更新时间：/);
    assert.match(note, /全市场A股（剔除 ST/);
  }));

  test('signal source failures retain a dated previous result and stale reports display no invented picks', () => run('signals', async page => {
    await page.locator('.strategy-stock-panel tbody tr').first().waitFor();
    await page.evaluate(() => { window.stockApi.scanStrategySignals = () => new Promise((_, reject) => { window.rejectSelection = reject; }); });
    await page.getByRole('button', { name: '重新选股', exact: true }).click();
    assert.match(await page.locator('.signal-test-status').innerText(), /上轮结果，数据日 2026-10-20/);
    assert.match(await page.locator('.strategy-method-note').innerText(), /上轮数据日：2026-10-20/);
    await page.evaluate(() => window.rejectSelection(new Error('选股来源暂不可用')));
    await page.getByRole('button', { name: '重新选股', exact: true }).waitFor();
    assert.match(await page.getByRole('alert').innerText(), /上轮结果，数据日 2026-10-20/);
    await page.evaluate(() => { window.stockApi.scanStrategySignals = async () => ({ ...window.selectionFixture,
      warning: '当前来源未更新至完整数据日', dataQuality: { ...window.selectionFixture.dataQuality, processed: 0, stale: 3, benchmarkReady: false },
      processed: 0, strategies: window.selectionFixture.strategies.map(group => ({ ...group, stocks: [] })) }); });
    await page.getByRole('button', { name: '重新选股', exact: true }).click();
    await page.getByRole('button', { name: '重新选股', exact: true }).waitFor();
    assert.equal(await page.locator('.strategy-stock-panel tbody tr').count(), 0);
    assert.match(await page.locator('.strategy-signals-view').innerText(), /3 只股票日线陈旧；基准行情未就绪/);
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
          logicBottom: root.querySelector('.trend-logic-overview')?.getBoundingClientRect().bottom ?? 0,
          heading: getComputedStyle(root.querySelector('h1')).fontSize,
          rowHeight: root.querySelector('.trend-result-row')?.getBoundingClientRect().height,
          // 结果工具条（结果策略 / 形态筛选 / 搜索）在窄视口会折行，高度直接决定
          // 「逻辑速读」与结果表之间那段必然留白的高度，供下面按实际折行数放宽阈值。
          toolbarHeight: root.querySelector('.trend-results-toolbar')?.getBoundingClientRect().height ?? 0,
          directoryWidth: directory?.getBoundingClientRect().width };
      }, view);
      const context = `${view} ${theme} ${width}: ${JSON.stringify(measure)}`;
      assert.ok(measure.overflow <= 2 && measure.rootOverflow <= 2, context);
      assert.equal(measure.heading, '18px', context);
      if (view === 'trend') {
        // D2-07b：原阈值写死 400px，在 760px 视口实测 411.64px 判红（超出 11.65px）。
        // 逐项测过：1480/1180/1024 三种宽度都稳定在 373.64px，760 只多出 38px，
        // 而多出的正是结果工具条从单行（48px）折成两行（86px）的高度，
        // 属于窄视口的正常换行，不是结果表被推远的回归。
        // 因此不再写死像素上限，而是按工具条实际折行数放宽：每多一行给 40px。
        const toolbarRows = Math.max(1, Math.round(measure.toolbarHeight / 48));
        assert.ok(measure.tableTop - measure.logicBottom < 400 + (toolbarRows - 1) * 40, context);
        assert.ok(measure.rowHeight <= 56, context);
      }
      // 策略库在视口 ≤1180px 时（@media max-width: 1180px）折到结果上方，更宽时固定在左侧 230px。
      if (view === 'signals' && width > 1180) assert.ok(measure.directoryWidth >= 220 && measure.directoryWidth <= 240, context);
      if (width === 1480 || width === 760) await page.screenshot({ path: path.join(output, `${view}-${theme}-${width}.png`), fullPage: false });
    }
  }));
});
