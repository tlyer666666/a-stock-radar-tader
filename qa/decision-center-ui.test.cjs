'use strict';

// 决策中心（v1.7.0）：在真实渲染器里验证 5 个页签、键盘切换、切页保活、1024/1280px 无横向溢出及 AI 问股跨页跳转。
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { openView } = require('./frontend-v150.cjs');

describe('决策中心 workspace in the actual renderer', () => {
  let server;
  let browser;
  let url;

  before(async () => {
    const { createServer } = await import('vite');
    const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module">
      import { createPreviewApi } from '/src/previewApi.ts';
      const api = createPreviewApi();
      const now = '2026-11-27T07:30:00.000Z';
      const emptySummary = () => ({
        total: 0, completed: 0, hit: 0, miss: 0, neutral: 0, unable: 0,
        enough: false, minSample: 10, hitRatePct: null, avgReturnPct: null, maxAdversePct: null
      });

      let signals = [
        {
          id: 'sig-600519', code: '600519', name: '贵州茅台', assetType: 'stock', status: 'active',
          createdAt: now, updatedAt: now, expiresAt: '2026-12-11', action: 'buy', horizon: '5d',
          entryLow: 1490, entryHigh: 1510, stopLoss: 1450, targetPrice: 1590,
          invalidation: '放量跌破 20 日均线且收不回 1450', watch: ['1490 承接', '白酒板块共振'],
          reason: '缩量回踩均线支撑，风险收益比合格', guardrail: '',
          stance: '偏多', confidence: '中', referencePrice: 1502.5,
          source: { conversationId: 'conv-decision-1', messageId: 'msg-a1', model: 'DeepSeek', skills: ['低吸回踩'] },
          outcomes: {
            '1': { status: 'done', verdict: 'hit', returnPct: 2.35, maxAdversePct: -0.45, stopHit: false, targetHit: false, endDate: '2026-11-28', endClose: 1537.8, startPrice: 1502.5 },
            '3': { status: 'done', verdict: 'hit', returnPct: 4.12, maxAdversePct: -0.45, stopHit: false, targetHit: false, endDate: '2026-12-02', endClose: 1564.4, startPrice: 1502.5 }
          },
          feedback: null
        },
        {
          id: 'sig-300750', code: '300750', name: '宁德时代', assetType: 'stock', status: 'active',
          createdAt: now, updatedAt: now, expiresAt: '2026-12-11', action: 'watch', horizon: '3d',
          entryLow: 218, entryHigh: 222, stopLoss: 208, targetPrice: 242,
          invalidation: '收盘跌破平台下沿 208', watch: ['突破 225 放量确认'],
          reason: '暂未突破压力位，先观察右侧信号', guardrail: '原建议缺止损边界已降级为观望',
          stance: '中性', confidence: '低', referencePrice: 220.4,
          source: { conversationId: 'conv-decision-2', messageId: 'msg-a2', model: 'DeepSeek', skills: ['量价分析'] },
          outcomes: {},
          feedback: 'useful'
        }
      ];
      const buildSignalList = list => ({
        signals: structuredClone(list),
        stats: {
          total: list.length,
          active: list.filter(item => item.status === 'active').length,
          byDays: {
            '1': { ...emptySummary(), total: 1, completed: 1, hit: 1 },
            '3': { ...emptySummary(), total: 1, completed: 1, hit: 1 },
            '5': emptySummary(),
            '10': emptySummary()
          },
          byAction: {},
          feedback: {
            useful: list.filter(item => item.feedback === 'useful').length,
            notUseful: list.filter(item => item.feedback === 'not_useful').length
          },
          minSample: 10,
          hitPct: 1
        },
        evaluation: null
      });

      const alertTypes = {
        ma_cross: '均线穿越', macd_cross: 'MACD 交叉', kdj_cross: 'KDJ 交叉',
        rsi: 'RSI 阈值', cci: 'CCI 阈值', market_light: '大盘红绿灯'
      };
      let alertState = {
        rules: [
          {
            id: 'rule-ma20', type: 'ma_cross', scope: 'watchlist', code: '', name: '',
            params: { window: 20, direction: 'up' }, enabled: true, cooldownHours: 24,
            createdAt: now, text: '全部自选 上穿 20 日均线'
          }
        ],
        history: [
          {
            id: 'hist-1', ruleId: 'rule-ma20', ruleText: '全部自选 上穿 20 日均线',
            target: '贵州茅台', code: '600519', status: 'triggered',
            detail: '收盘 1502.50 上穿 MA20 1492.10', at: now
          }
        ],
        lastRunAt: now,
        types: alertTypes
      };

      let feeds = [
        { id: 'feed-1', name: '财经精选 RSS', url: 'https://example.invalid/finance/rss.xml', enabled: true },
        { id: 'feed-2', name: '宏观周报 Atom', url: 'https://example.invalid/macro/atom.xml', enabled: false }
      ];

      const decisionConversation = {
        id: 'conv-decision-1',
        title: '贵州茅台 · 趋势分析',
        focus: { code: '600519', name: '贵州茅台' },
        createdAt: now,
        updatedAt: now,
        messages: [
          { id: 'msg-u1', role: 'user', content: '帮我分析一下贵州茅台能否关注？', at: now, focus: { code: '600519', name: '贵州茅台' } },
          {
            id: 'msg-a1', role: 'assistant', content: '**结论：回踩 1490–1510 区间具备观察价值，止损设在 1450。**',
            stance: '偏多', confidence: '中', model: 'deepseek-chat', at: now, durationMs: 4200,
            focus: { code: '600519', name: '贵州茅台' },
            decision: {
              id: 'sig-600519', action: 'buy', actionLabel: '买入', horizon: '5d', horizonLabel: '5 日',
              entryLow: 1490, entryHigh: 1510, stopLoss: 1450, targetPrice: 1590,
              invalidation: '放量跌破 20 日均线且收不回 1450', watch: ['1490 承接'], guardrail: '',
              expiresAt: '2026-12-11', created: true
            }
          }
        ]
      };

      window.__decisionCalls = { signals: 0, alerts: [], factors: 0, rotation: 0, feeds: [] };

      api.alertRules = async (input = { op: 'list' }) => {
        window.__decisionCalls.alerts.push(input.op || 'list');
        if (input.op === 'dry') {
          return {
            ...structuredClone(alertState),
            dry: [{ ruleId: input.id, target: '贵州茅台', code: '600519', status: 'triggered', detail: '试跑命中：收盘站上 20 日均线' }]
          };
        }
        if (input.op === 'run') {
          alertState.lastRunAt = now;
          return { ...structuredClone(alertState), run: { at: now, triggered: 1, evaluated: alertState.rules.length } };
        }
        if (input.op === 'save' && input.rule) {
          const id = input.rule.id || 'rule-' + (alertState.rules.length + 1);
          const next = { ...input.rule, id, createdAt: input.rule.createdAt || now, text: input.rule.text || '新规则' };
          alertState.rules = alertState.rules.some(item => item.id === id)
            ? alertState.rules.map(item => item.id === id ? next : item)
            : [...alertState.rules, next];
        } else if (input.op === 'remove' && input.id) {
          alertState.rules = alertState.rules.filter(item => item.id !== input.id);
        } else if (input.op === 'clear') {
          alertState.history = [];
        }
        return structuredClone(alertState);
      };

      api.screenFactors = async (input = {}) => {
        window.__decisionCalls.factors += 1;
        const strategyId = input.strategyId || 'quality_value';
        return {
          strategy: {
            id: strategyId, name: '质量价值', summary: '赚钱能力强、估值不贵',
            weights: [
              { id: 'roe', label: 'ROE', weight: 40, higher: true },
              { id: 'pe', label: '滚动市盈率', weight: 30, higher: false },
              { id: 'ret60', label: '60日涨幅', weight: 30, higher: true }
            ]
          },
          strategies: [{ id: 'quality_value', name: '质量价值', summary: '赚钱能力强、估值不贵' }],
          reportPeriod: '2026三季报',
          generatedAt: now,
          warnings: [],
          note: '模拟多因子打分结果，仅用于界面回归验证。',
          funnel: { universe: 5100, tradable: 4200, passedFilters: 980, scored: 980, candidates: 100, barsFailed: 0, qualified: 20 },
          picks: [
            {
              rank: 1, code: '600519', name: '贵州茅台', industry: '白酒', score: 92.4, coveragePct: 100,
              latest: 1502.5, changePct: 1.42, marketCapYi: 18800,
              factors: {
                roe: { label: 'ROE', unit: '%', value: 24.8, score: 97, weight: 40 },
                pe: { label: 'PE', unit: '倍', value: 21.3, score: 86, weight: 30 }
              },
              whySelected: [{ code: 'roe', text: 'ROE 24.8% 居全市场前 3%', quality: 'observed', source: '财报' }],
              whyNow: [{ code: 'ret60', text: '近 60 日稳步抬升 +8.4%', quality: 'observed', source: '日线' }],
              explanationQuality: { whySelected: 'ok', whyNow: 'ok' },
              reportLabel: '2026Q3', reportPeriod: '2026-09-30'
            }
          ]
        };
      };

      api.getEtfRotation = async (config = {}) => {
        window.__decisionCalls.rotation += 1;
        return {
          config: {
            pool: ['510300', '510500', '159915', '512890', '513100', '518880'],
            safeAsset: '511880',
            lookback: config.lookback || 60,
            rebalance: config.rebalance || 'weekly',
            topN: config.topN || 2,
            bufferPct: 2,
            costBps: 10,
            years: 8
          },
          warnings: [],
          asOf: '2026-11-27',
          generatedAt: now,
          signal: {
            asOf: '2026-11-27',
            holdings: [{ code: '513100', name: '纳指ETF', safe: false }, { code: '518880', name: '黄金ETF', safe: false }],
            targets: [{ code: '513100', name: '纳指ETF', weightPct: 50 }, { code: '518880', name: '黄金ETF', weightPct: 50 }],
            idleWeightPct: 0, idleTo: '银华日利（货币）', needRebalance: false, isRebalanceDay: true,
            ranking: [
              { code: '513100', name: '纳指ETF', momentumPct: 9.8, selected: true, positive: true },
              { code: '518880', name: '黄金ETF', momentumPct: 6.2, selected: true, positive: true },
              { code: '510300', name: '沪深300ETF', momentumPct: -1.4, selected: false, positive: false }
            ]
          },
          performance: {
            from: '2019-01-02', to: '2026-11-27',
            strategy: { totalPct: 128.4, years: 7.9, maxDrawdownPct: 14.2, annualPct: 11.1, volPct: 13.5, sharpe: 0.82, calmar: 0.78 },
            benchmark: { totalPct: 76.2, years: 7.9, maxDrawdownPct: 24.5, annualPct: 7.4, volPct: 15.8, sharpe: 0.47, calmar: 0.30 }
          },
          yearly: [
            { year: '2025', strategyPct: 14.6, benchmarkPct: 9.2, partial: false },
            { year: '2026', strategyPct: 10.3, benchmarkPct: 6.1, partial: true }
          ],
          sweep: [
            { lookback: 40, annualPct: 10.4, maxDrawdownPct: 15.1, sharpe: 0.76, current: false },
            { lookback: 60, annualPct: 11.1, maxDrawdownPct: 14.2, sharpe: 0.82, current: true },
            { lookback: 80, annualPct: 10.8, maxDrawdownPct: 14.8, sharpe: 0.79, current: false }
          ],
          rebalances: [
            { signalDate: '2026-11-20', tradeDate: '2026-11-23', out: ['红利低波ETF'], in: ['黄金ETF'], holdings: ['纳指ETF', '黄金ETF'], costPct: 0.1 }
          ],
          rebalanceCount: 42,
          curve: [
            { date: '2026-01-05', strategy: 1.0, benchmark: 1.0 },
            { date: '2026-06-01', strategy: 1.08, benchmark: 1.03 },
            { date: '2026-11-27', strategy: 1.15, benchmark: 1.07 }
          ]
        };
      };

      api.ai = {
        ...api.ai,
        agent: {
          ...api.ai.agent,
          state: async () => ({
            configured: true,
            model: 'deepseek-chat',
            profileName: 'DeepSeek',
            profileId: 'p1',
            activeProfileId: 'p1',
            profiles: [{ id: 'p1', name: 'DeepSeek', model: 'deepseek-chat' }],
            memory: '',
            conversations: [{
              id: decisionConversation.id,
              title: decisionConversation.title,
              focus: decisionConversation.focus,
              createdAt: now,
              updatedAt: now,
              turns: 1,
              stance: '偏多',
              running: false
            }],
            tools: [],
            skillIds: []
          }),
          conversation: async id => (id === decisionConversation.id ? structuredClone(decisionConversation) : null),
          signals: async (input = {}) => {
            window.__decisionCalls.signals += 1;
            const filtered = signals.filter(item => (!input.status || item.status === input.status) && (!input.code || item.code === input.code));
            return buildSignalList(filtered);
          },
          updateSignal: async input => {
            if (input.remove) signals = signals.filter(item => item.id !== input.id);
            else signals = signals.map(item => item.id === input.id ? { ...item, ...(input.status ? { status: input.status } : {}), ...(input.feedback !== undefined ? { feedback: input.feedback } : {}), updatedAt: now } : item);
            return buildSignalList(signals);
          },
          feeds: async (input = { op: 'list' }) => {
            window.__decisionCalls.feeds.push(input.op || 'list');
            if (input.op === 'save' && input.url) {
              const id = input.id || 'feed-' + (feeds.length + 1);
              const next = { id, name: input.name || '新资讯源', url: input.url, enabled: input.enabled !== false };
              feeds = feeds.some(item => item.id === id) ? feeds.map(item => item.id === id ? next : item) : [...feeds, next];
            } else if (input.op === 'remove' && input.id) {
              feeds = feeds.filter(item => item.id !== input.id);
            } else if (input.op === 'test') {
              return { feeds: structuredClone(feeds), maxFeeds: 12, test: { count: 3, sample: ['样例快讯 1', '样例快讯 2'] } };
            }
            return { feeds: structuredClone(feeds), maxFeeds: 12 };
          }
        }
      };

      window.stockApi = api;
      await import('/src/main.tsx');
    </script></body></html>`;

    server = await createServer({
      plugins: [{
        name: 'decision-center-ui-fixture',
        configureServer(vite) {
          vite.middlewares.use(async (request, response, next) => {
            if (request.url?.split('?')[0] !== '/__decision_center__') return next();
            try {
              response.setHeader('Content-Type', 'text/html');
              response.end(await vite.transformIndexHtml(request.url, html));
            } catch (error) {
              next(error);
            }
          });
        }
      }],
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error'
    });
    await server.listen();
    url = `http://127.0.0.1:${server.httpServer.address().port}/__decision_center__`;
    browser = await require('playwright-core').chromium.launch({
      executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      headless: true
    });
  });

  after(async () => {
    await browser?.close();
    await server?.close();
  });

  async function withPage(viewport, run) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.route('**/*', route => (/^https?:\/\/127\.0\.0\.1(?::\d+)?\//.test(route.request().url()) ? route.continue() : route.abort()));
    try {
      await page.goto(url);
      await page.locator('.workspace-navigation').waitFor({ timeout: 15000 });
      await run(page);
      assert.deepEqual(errors, [], 'renderer must not throw');
    } finally {
      await page.close();
    }
  }

  test('all 5 tabs render, ArrowRight switches tabs, and keep-alive preserves mounted state', async () => withPage({ width: 1280, height: 900 }, async page => {
    await openView(page, 'decision', '决策中心');
    const tablist = page.getByRole('tablist', { name: '决策中心功能' });
    await tablist.waitFor();

    const expectedTabs = ['AI 建议', '指标预警', '多因子选股', 'ETF 轮动', '资讯源'];
    for (const label of expectedTabs) {
      assert.equal(await tablist.getByRole('tab', { name: label, exact: true }).count(), 1, `missing tab ${label}`);
    }

    // 1. Default tab: AI 建议
    const signalsTab = tablist.getByRole('tab', { name: 'AI 建议', exact: true });
    assert.equal(await signalsTab.getAttribute('aria-selected'), 'true');
    await page.locator('.agent-signals-table tbody tr').first().waitFor();
    assert.equal(await page.locator('.agent-signals-table tbody tr').count(), 2);
    assert.match(await page.locator('.agent-signals-table').innerText(), /贵州茅台/);

    // 2. Keyboard ArrowRight -> 指标预警
    await signalsTab.focus();
    await signalsTab.press('ArrowRight');
    const alertsTab = tablist.getByRole('tab', { name: '指标预警', exact: true });
    assert.equal(await alertsTab.getAttribute('aria-selected'), 'true');
    assert.equal(await alertsTab.evaluate(el => document.activeElement === el), true, 'ArrowRight moves focus to next tab');
    await page.locator('#decision-panel-alerts .alert-rules-list li').first().waitFor();
    assert.match(await page.locator('#decision-panel-alerts').innerText(), /全部自选 上穿 20 日均线/);
    // Trigger dry-run to produce local UI state inside 指标预警 panel
    await page.locator('#decision-panel-alerts').getByRole('button', { name: '试跑' }).first().click();
    await page.locator('#decision-panel-alerts .alert-rules-dry').waitFor();
    assert.match(await page.locator('#decision-panel-alerts .alert-rules-dry').innerText(), /试跑命中/);

    // 3. Keyboard ArrowRight -> 多因子选股
    await alertsTab.focus();
    await alertsTab.press('ArrowRight');
    const factorsTab = tablist.getByRole('tab', { name: '多因子选股', exact: true });
    assert.equal(await factorsTab.getAttribute('aria-selected'), 'true');
    await page.locator('#decision-panel-factors').getByRole('button', { name: '开始选股', exact: true }).click();
    await page.locator('#decision-panel-factors .factor-screen-table tbody tr').first().waitFor();
    assert.match(await page.locator('#decision-panel-factors .factor-screen-table').innerText(), /贵州茅台/);

    // 4. Keyboard ArrowRight -> ETF 轮动
    await factorsTab.focus();
    await factorsTab.press('ArrowRight');
    const rotationTab = tablist.getByRole('tab', { name: 'ETF 轮动', exact: true });
    assert.equal(await rotationTab.getAttribute('aria-selected'), 'true');
    await page.locator('#decision-panel-rotation').getByRole('button', { name: '计算最新信号与回测', exact: true }).click();
    await page.locator('#decision-panel-rotation .etf-rotation-curve').waitFor();
    assert.match(await page.locator('#decision-panel-rotation').innerText(), /纳指ETF/);

    // 5. Keyboard ArrowRight -> 资讯源
    await rotationTab.focus();
    await rotationTab.press('ArrowRight');
    const feedsTab = tablist.getByRole('tab', { name: '资讯源', exact: true });
    assert.equal(await feedsTab.getAttribute('aria-selected'), 'true');
    await page.locator('#decision-panel-feeds .alert-rules-list li').first().waitFor();
    assert.match(await page.locator('#decision-panel-feeds').innerText(), /财经精选 RSS/);

    // Keep-alive check within 决策中心: return to 指标预警 -> dry-run result is still mounted & preserved
    await alertsTab.click();
    assert.equal(await alertsTab.getAttribute('aria-selected'), 'true');
    assert.equal(await page.locator('#decision-panel-alerts .alert-rules-dry').isVisible(), true, 'keep-alive preserves dry-run panel across tab switches');

    // Switch away to another workspace and return to 决策中心 -> remembers active tab and cached factor/rotation results
    await openView(page, 'dashboard', '涨停监控');
    await openView(page, 'decision', '决策中心');
    assert.equal(await page.getByRole('tablist', { name: '决策中心功能' }).getByRole('tab', { name: '指标预警', exact: true }).getAttribute('aria-selected'), 'true', 'remembered active tab survives workspace navigation');
    await page.getByRole('tablist', { name: '决策中心功能' }).getByRole('tab', { name: '多因子选股', exact: true }).click();
    assert.equal(await page.locator('#decision-panel-factors .factor-screen-table tbody tr').count(), 1, 'factor screen result stays cached across workspace switch');
    await page.getByRole('tablist', { name: '决策中心功能' }).getByRole('tab', { name: 'ETF 轮动', exact: true }).click();
    assert.equal(await page.locator('#decision-panel-rotation .etf-rotation-curve').isVisible(), true, 'ETF rotation report stays cached across workspace switch');
  }));

  for (const width of [1024, 1280]) {
    test(`${width}px: 决策中心 has zero horizontal overflow and unobscured「核对最新结果」button`, async () => withPage({ width, height: 900 }, async page => {
      await openView(page, 'decision', '决策中心');
      await page.locator('.agent-signals-table tbody tr').first().waitFor();
      const refreshBtn = page.locator('.main > .page').getByRole('button', { name: '核对最新结果', exact: true });
      await refreshBtn.waitFor();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

      const overflow = await page.evaluate(() => {
        const pageEl = document.querySelector('.main > .page');
        return {
          docScroll: document.documentElement.scrollWidth,
          docClient: document.documentElement.clientWidth,
          pageScroll: pageEl.scrollWidth,
          pageClient: pageEl.clientWidth
        };
      });
      assert.ok(overflow.pageScroll <= overflow.pageClient + 1, `.main > .page overflowed at ${width}px: ${JSON.stringify(overflow)}`);
      assert.ok(overflow.docScroll <= overflow.docClient + 1, `document overflowed at ${width}px: ${JSON.stringify(overflow)}`);

      const btnMetrics = await refreshBtn.evaluate(el => {
        const rect = el.getBoundingClientRect();
        const cx = rect.left + rect.width / 2;
        const cy = rect.top + rect.height / 2;
        const topEl = document.elementFromPoint(cx, cy);
        return {
          width: rect.width,
          height: rect.height,
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          viewportWidth: window.innerWidth,
          viewportHeight: window.innerHeight,
          unobscured: Boolean(topEl && (topEl === el || el.contains(topEl)))
        };
      });
      assert.ok(btnMetrics.width >= 20 && btnMetrics.height >= 20, `button not visible: ${JSON.stringify(btnMetrics)}`);
      assert.ok(btnMetrics.left >= 0 && btnMetrics.right <= btnMetrics.viewportWidth, `button clipped horizontally: ${JSON.stringify(btnMetrics)}`);
      assert.ok(btnMetrics.top >= 0 && btnMetrics.bottom <= btnMetrics.viewportHeight, `button clipped vertically: ${JSON.stringify(btnMetrics)}`);
      assert.equal(btnMetrics.unobscured, true, `button obscured: ${JSON.stringify(btnMetrics)}`);
    }));
  }

  test('clicking「查看全部建议」from AI 问股 navigates to 决策中心 with AI 建议 tab active', async () => withPage({ width: 1280, height: 900 }, async page => {
    // Move 决策中心 away from AI 建议 first so landing back on AI 建议 proves explicit tab handoff
    await openView(page, 'decision', '决策中心');
    await page.getByRole('tablist', { name: '决策中心功能' }).getByRole('tab', { name: '资讯源', exact: true }).click();
    assert.equal(await page.getByRole('tablist', { name: '决策中心功能' }).getByRole('tab', { name: '资讯源', exact: true }).getAttribute('aria-selected'), 'true');

    await openView(page, 'ai-agent', 'AI 问股');
    const threadBtn = page.locator('.ai-agent-thread-open').filter({ hasText: '贵州茅台' }).first();
    await threadBtn.waitFor();
    await threadBtn.click();

    const decisionCard = page.locator('.agent-decision');
    await decisionCard.waitFor();
    await decisionCard.getByRole('button', { name: '查看全部建议', exact: true }).click();

    await page.locator('.app-shell[data-workspace="decision"]').waitFor();
    const signalsTab = page.getByRole('tablist', { name: '决策中心功能' }).getByRole('tab', { name: 'AI 建议', exact: true });
    await signalsTab.waitFor();
    assert.equal(await signalsTab.getAttribute('aria-selected'), 'true');
    await page.locator('.agent-signals-table tbody tr').first().waitFor();
  }));
});
