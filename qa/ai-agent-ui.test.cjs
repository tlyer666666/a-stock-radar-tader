'use strict';

// AI 问股（1.6.53）：在真实渲染器里用模拟的 AI 接口走一遍选股、提问、看进度、追问、删除和偏好。
const { test, before, after, describe } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');

const ANSWER = [
  '**结论：震荡偏多，回踩 1490 附近可以关注。**',
  '',
  '### 走势与技术面',
  '- 5 日涨 +3.20%，20 日 -1.50%，均线交织',
  '- MACD 刚金叉，RSI14 52',
  '  - 量比 1.3，温和放量',
  '',
  '### 关键价位',
  '| 类型 | 价位 | 依据 |',
  '|---|---:|---|',
  '| 支撑 | 1490 | 5日线 |',
  '| 压力 | 1510 | 20日线 |',
  '',
  '> 区间 3-5% 的波动属于正常。',
  '',
  '### 操作思路',
  '1. 已持有：跌破 1490 减仓。',
  '2. 未持有：站稳 1510 再考虑。'
].join('\n');

describe('AI 问股 page in the actual renderer', () => {
  let browser, server, base;
  const screenshotDir = path.resolve(__dirname, '../artifacts/frontend-v150/ai-agent');

  before(async () => {
    const { createServer } = await import('vite');
    const mainSource = await fs.readFile(path.resolve(__dirname, '../src/main.tsx'), 'utf8');
    const cssImports = [...mainSource.matchAll(/^import "\.\/([^"\n]+\.css)";/gm)].map(match => `import '/src/${match[1]}';`).join('\n');
    const skillLib = require('../electron/stock-agent-skills.cjs');
    const toolList = require('../electron/stock-agent-tools.cjs').STOCK_AGENT_TOOLS.map(tool => ({ id: tool.id, name: tool.name }));
    const builtinCatalog = skillLib.skillCatalog([], id => toolList.find(tool => tool.id === id)?.name || id);
    const html = `<!doctype html><html data-theme="light"><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import AiAgentView from '/src/features/ai-agent/AiAgentView.tsx';
      ${cssImports}
      import { createPreviewApi } from '/src/previewApi.ts';
      const params = new URLSearchParams(location.search);
      const configured = params.get('configured') !== '0';
      const failFirst = params.get('fail') === '1';
      const answer = ${JSON.stringify(ANSWER)};
      window.calls = { start: [], settings: [], cancel: [], remove: [], opened: [], skillSave: [], skillRemove: [] };
      const conversations = [];
      const runs = new Map();
      let seq = 0;
      const now = () => new Date().toISOString();
      const summary = c => ({ id: c.id, title: c.title, focus: c.focus, createdAt: c.createdAt, updatedAt: c.updatedAt,
        turns: c.messages.filter(m => m.role === 'user').length, stance: [...c.messages].reverse().find(m => m.role === 'assistant' && !m.error)?.stance,
        running: [...runs.values()].some(r => r.conversationId === c.id && r.status === 'running') });
      let memory = '';
      const builtin = ${JSON.stringify(builtinCatalog)};
      const toolList = ${JSON.stringify(toolList)};
      let customSkills = [];
      let skillIds = params.get('skills') ? params.get('skills').split(',') : [];
      const catalog = () => ({ ...builtin, skills: [...builtin.skills, ...customSkills] });
      const state = () => ({ configured, model: 'deepseek-chat', profileName: 'DeepSeek', profileId: '', activeProfileId: 'p1',
        profiles: [{ id: 'p1', name: 'DeepSeek', model: 'deepseek-chat' }, { id: 'p2', name: '通义千问', model: 'qwen-max' }], memory,
        conversations: conversations.map(summary), tools: toolList, skills: catalog(), skillIds: [...skillIds] });
      const skillName = id => catalog().skills.find(skill => skill.id === id)?.name || id;
      const steps = [
        { kind: 'prefetch', thought: '先读取贵州茅台的实时行情和日线体检', calls: [
          { tool: 'quote', name: '实时行情', args: 'code=600519', status: 'ok', summary: '贵州茅台 现价 1500，涨跌 1.2%' },
          { tool: 'profile', name: '日线体检', args: 'code=600519', status: 'ok', summary: '均线交织，20日 -1.5%' }] },
        { kind: 'tools', thought: '看短线数据和策略信号', calls: [
          { tool: 'limit_status', name: '涨停与龙虎榜', args: 'code=600519', status: 'running', summary: '' },
          { tool: 'strategies', name: '策略信号', args: 'code=600519', status: 'running', summary: '' }] }];
      const api = createPreviewApi();
      api.search = async q => [{ code: '600519', name: '贵州茅台', secid: '1.600519', assetType: 'stock', marketName: 'A股' }, { code: '512690', name: '酒ETF', secid: '1.512690', assetType: 'etf' }]
        .filter(item => item.name.includes(q) || item.code.includes(q) || q === 'gzmt');
      api.getQuoteSnapshot = async () => ({ quote: { latest: 1500.5, changePct: 1.23 } });
      api.ai = { agent: {
        state: async () => state(),
        conversation: async id => { const c = conversations.find(item => item.id === id); if (!c) return null; const r = [...runs.values()].find(item => item.conversationId === id && item.status === 'running'); return structuredClone({ ...c, ...(r ? { runningRunId: r.id } : {}) }); },
        start: async input => {
          window.calls.start.push(input);
          if (!configured) throw new Error('[AI_NOT_CONFIGURED] 请先在「数据源设置 → AI 助手」添加模型配置');
          let c = input.conversationId ? conversations.find(item => item.id === input.conversationId) : null;
          if (!c) { c = { id: 'c' + (++seq), title: (input.focus ? input.focus.name + ' · ' : '') + input.message.slice(0, 18), focus: input.focus || null, createdAt: now(), updatedAt: now(), messages: [] }; conversations.unshift(c); }
          const used = Array.isArray(input.skillIds) ? input.skillIds : skillIds;
          if (Array.isArray(input.skillIds)) skillIds = [...input.skillIds];
          const tags = used.map(id => ({ id, name: skillName(id) }));
          c.messages.push({ id: 'm' + (++seq), role: 'user', content: input.message, at: now(), ...(input.focus ? { focus: input.focus } : {}), ...(tags.length ? { skills: tags } : {}) });
          const run = { id: 'r' + (++seq), conversationId: c.id, status: 'running', polls: 0, fail: failFirst && seq < 6, tags };
          runs.set(run.id, run);
          return { runId: run.id, conversationId: c.id };
        },
        poll: async runId => {
          const run = runs.get(runId); const c = conversations.find(item => item.id === run.conversationId);
          run.polls += 1;
          const base = { runId, conversationId: run.conversationId, startedAt: now(), elapsedMs: run.polls * 800, model: 'DeepSeek' };
          if (run.status !== 'running') return { ...base, status: run.status, steps: [] };
          if (run.polls < (window.slowRuns ? 400 : 3)) return { ...base, status: 'running', steps: steps.slice(0, run.polls) };
          const message = run.fail
            ? { id: 'm' + (++seq), role: 'assistant', content: 'AI 接口限流或额度已用完，请稍后再试（HTTP 429）', error: true, at: now(), model: 'DeepSeek' }
            : { id: 'm' + (++seq), role: 'assistant', content: answer, stance: '偏多', confidence: '中', followUps: ['明天怎么操作？', '和五粮液比呢？', '支撑在哪？'],
              steps: steps.map(step => ({ ...step, calls: step.calls.map(call => ({ ...call, status: 'ok', summary: call.summary || '已取到' })) })),
              model: 'deepseek-chat', at: now(), durationMs: 23000, focus: c.focus || undefined,
              ...(run.tags.length ? { skills: run.tags, skillVerdicts: run.tags.map((tag, index) => ({ id: tag.id, skill: tag.name, verdict: ['接近', '不符合', '符合'][index % 3], reason: index ? '目标空间只有止损的 1.3 倍' : '缩量回调，离 10 日线还有 2%' })) } : {}) };
          c.messages.push(message); c.updatedAt = now();
          run.status = run.fail ? 'error' : 'done';
          return { ...base, status: run.status, steps: [], message, ...(run.fail ? { error: message.content } : {}) };
        },
        cancel: async runId => {
          window.calls.cancel.push(runId);
          const run = runs.get(runId); const c = conversations.find(item => item.id === run.conversationId);
          run.status = 'cancelled';
          c.messages.push({ id: 'm' + (++seq), role: 'assistant', content: '已停止。', error: true, cancelled: true, at: now(), model: 'DeepSeek' });
          return null;
        },
        remove: async id => { window.calls.remove.push(id); conversations.splice(conversations.findIndex(item => item.id === id), 1); return state(); },
        settings: async input => { window.calls.settings.push(input); if (typeof input.memory === 'string') memory = input.memory; if (Array.isArray(input.skillIds)) skillIds = [...input.skillIds]; return state(); },
        saveSkill: async input => {
          window.calls.skillSave.push(input);
          if ([...builtin.skills, ...customSkills].some(skill => skill.name === input.name && skill.id !== input.id)) throw new Error('[AGENT_INVALID] 已经有叫「' + input.name + '」的打法了，换个名字');
          const skill = { id: input.id || 'sk_ui' + (++seq) + 'abc', name: input.name, group: '我的打法', summary: '', custom: true, method: input.method, toolIds: input.tools,
            tools: input.tools.map(id => toolList.find(tool => tool.id === id)?.name || id) };
          customSkills = input.id ? customSkills.map(item => item.id === input.id ? skill : item) : [...customSkills, skill];
          return { ...state(), savedSkillId: skill.id };
        },
        removeSkill: async id => { window.calls.skillRemove.push(id); customSkills = customSkills.filter(skill => skill.id !== id); skillIds = skillIds.filter(item => item !== id); return state(); }
      } };
      window.stockApi = api;
      createRoot(document.getElementById('root')).render(React.createElement(React.StrictMode, null,
        React.createElement('div', { className: 'app-shell terminal-shell', 'data-workspace': 'ai-agent' },
          React.createElement('div', { className: 'window-dragbar' }, 'AI 问股界面验证 · 模拟接口'),
          React.createElement('aside', { className: 'sidebar' }, React.createElement('strong', null, '工作台'), React.createElement('button', { className: 'nav-item active' }, 'AI 问股')),
          React.createElement('main', { className: 'main' },
            React.createElement('header', { className: 'topbar' }, '模拟 AI 接口 · 仅验证界面交互'),
            React.createElement('div', { className: 'page' }, React.createElement(AiAgentView, { onOpenStock(stock) { window.calls.opened.push(stock.code); }, onOpenSettings() {} })),
            React.createElement('footer', { className: 'terminal-statusbar' }, '模拟数据')))));
    </script></body></html>`;
    server = await createServer({
      plugins: [{ name: 'ai-agent-fixture', configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url?.split('?')[0] !== '/__ai_agent__') return next();
          try { response.setHeader('Content-Type', 'text/html'); response.end(await vite.transformIndexHtml(request.url, html)); } catch (error) { next(error); }
        });
      } }],
      server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error'
    });
    await server.listen();
    base = `http://127.0.0.1:${server.httpServer.address().port}/__ai_agent__`;
    browser = await require('playwright-core').chromium.launch({
      executablePath: process.env.QA_CHROMIUM_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true
    });
    await fs.mkdir(screenshotDir, { recursive: true });
  });

  after(async () => { await browser?.close(); await server?.close(); });

  async function pageTest(run, query = '', viewport = { width: 1480, height: 960 }) {
    const page = await browser.newPage({ viewport });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(6000);
    try {
      await page.goto(`${base}${query}`);
      await page.locator('.ai-agent-view').waitFor();
      await run(page);
      assert.deepEqual(errors, [], 'the renderer must not throw');
    } finally { await page.close(); }
  }
  const pickStock = async page => {
    await page.getByLabel('选择要分析的股票').fill('茅台');
    await page.locator('.ai-agent-options [role="option"]').first().waitFor();
    assert.equal(await page.locator('.ai-agent-options [role="option"]').count(), 1, 'ETFs are not offered');
    await page.getByLabel('选择要分析的股票').press('Enter');
    await page.locator('.ai-agent-focus').waitFor();
  };

  test('choose a stock, run a full analysis with live steps, read the answer and ask a follow-up', async () => pageTest(async page => {
    assert.match(await page.locator('.ai-agent-welcome h2').innerText(), /先选一只股票/);
    assert.equal(await page.getByRole('button', { name: /^全面分析/ }).isDisabled(), true, 'stock tasks wait for a stock');
    assert.equal(await page.getByRole('button', { name: /^今日市场/ }).isDisabled(), false);
    await pickStock(page);
    assert.match(await page.locator('.ai-agent-focus').innerText(), /贵州茅台\s*600519\s*1500\.50 \+1\.23%/);
    assert.equal(await page.locator('.ai-agent-focus em.up').count(), 1);
    assert.match(await page.locator('.ai-agent-welcome h2').innerText(), /想了解 贵州茅台 的什么/);
    await page.getByRole('button', { name: /^全面分析/ }).click();
    await page.locator('.ai-agent-msg.assistant.running').waitFor();
    assert.match(await page.locator('.ai-agent-msg.user .ai-agent-bubble').innerText(), /全面分析一下贵州茅台/);
    await page.locator('.ai-agent-call').first().waitFor();
    assert.equal(await page.getByRole('button', { name: '停止' }).count() >= 1, true);
    const started = await page.evaluate(() => window.calls.start[0]);
    assert.deepEqual(started.focus, { code: '600519', name: '贵州茅台' });
    await page.locator('.ai-agent-msg.assistant:not(.running) .agent-markdown').waitFor();
    // 回答：立场、表格、正负百分数着色、区间不着色、列表嵌套、步骤摘要、追问。
    assert.equal(await page.locator('.agent-stance.up').innerText(), '偏多');
    assert.equal(await page.locator('.agent-markdown table tbody tr').count(), 2);
    assert.equal(await page.locator('.agent-markdown td').nth(1).evaluate(cell => getComputedStyle(cell).textAlign), 'right');
    assert.deepEqual(await page.locator('.agent-num').evaluateAll(nodes => nodes.map(node => [node.textContent, node.className])), [['+3.20%', 'agent-num up'], ['-1.50%', 'agent-num down']]);
    assert.match(await page.locator('.agent-markdown blockquote').innerText(), /3-5%/);
    assert.equal(await page.locator('.agent-markdown li ul li').count(), 1);
    assert.equal(await page.locator('.agent-markdown ol li').count(), 2);
    assert.match(await page.locator('.ai-agent-steps-box summary').innerText(), /查了 4 项数据：实时行情、日线体检、涨停与龙虎榜、策略信号/);
    assert.equal(await page.locator('.ai-agent-thread').count(), 1);
    assert.match(await page.locator('.ai-agent-thread small').innerText(), /600519 · 1 问[\s\S]*偏多/);
    await page.screenshot({ path: path.join(screenshotDir, 'answer-light-1480.png'), animations: 'disabled' });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await page.screenshot({ path: path.join(screenshotDir, 'answer-dark-1480.png'), animations: 'disabled' });

    await page.locator('.ai-agent-followups').getByRole('button', { name: '明天怎么操作？' }).click();
    await page.waitForFunction(() => window.calls.start.length === 2);
    const second = await page.evaluate(() => window.calls.start[1]);
    assert.equal(second.conversationId, started.conversationId === undefined ? 'c1' : started.conversationId || 'c1');
    await page.waitForFunction(() => document.querySelectorAll('.ai-agent-msg.assistant:not(.running)').length === 2);
    assert.equal(await page.locator('.ai-agent-followups').count(), 1, 'only the latest answer offers follow-ups');
    // 新回答出来后滚到这次提问处，从回答开头读。
    await page.waitForFunction(() => {
      const stream = document.querySelector('.ai-agent-stream'), questions = document.querySelectorAll('.ai-agent-msg.user');
      const offset = questions[questions.length - 1].getBoundingClientRect().top - stream.getBoundingClientRect().top;
      return offset >= 0 && offset < 40;
    });
    assert.match(await page.locator('.ai-agent-thread small').innerText(), /2 问/);
    // 快捷问题条不再重复「全面分析」同一只股票。
    assert.equal(await page.locator('.ai-agent-quick').getByRole('button', { name: '全面分析' }).count(), 0);
    // 布局：页面不横向溢出，输入框在窗口内，消息流在面板内滚动。
    const layout = await page.evaluate(() => {
      const stream = document.querySelector('.ai-agent-stream'), composer = document.querySelector('.ai-agent-composer');
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, composerBottom: composer.getBoundingClientRect().bottom,
        height: innerHeight, streamScrolls: stream.scrollHeight > stream.clientHeight, atBottom: Math.abs(stream.scrollHeight - stream.clientHeight - stream.scrollTop) < 4 };
    });
    assert.ok(layout.overflow <= 1, JSON.stringify(layout));
    assert.ok(layout.composerBottom <= layout.height, JSON.stringify(layout));
    assert.ok(layout.streamScrolls, 'long answers scroll inside the chat panel');
    await page.screenshot({ path: path.join(screenshotDir, 'followup-dark-1480.png'), animations: 'disabled' });
  }));

  test('stop a running analysis, delete a conversation with confirmation and save the analysis preference', async () => pageTest(async page => {
    await page.evaluate(() => { window.slowRuns = true; });
    await pickStock(page);
    await page.getByRole('textbox', { name: '向 AI 提问' }).fill('茅台能买吗？');
    await page.getByRole('textbox', { name: '向 AI 提问' }).press('Enter');
    await page.locator('.ai-agent-msg.assistant.running').waitFor();
    assert.equal(await page.getByLabel('选择要分析的股票').isDisabled(), true, 'the stock cannot change mid-run');
    await page.locator('.ai-agent-composer').getByRole('button', { name: '停止' }).click();
    await page.locator('.ai-agent-msg.failed').waitFor();
    assert.match(await page.locator('.ai-agent-msg.failed').innerText(), /已停止/);
    assert.equal((await page.evaluate(() => window.calls.cancel)).length, 1);

    const thread = page.locator('.ai-agent-thread').first();
    await thread.hover();
    await thread.getByRole('button', { name: /^删除/ }).click();
    assert.equal(await thread.getByRole('button', { name: /^确认删除/ }).count(), 1, 'the first click only asks for confirmation');
    await thread.getByRole('button', { name: /^确认删除/ }).click();
    await page.waitForFunction(() => !document.querySelector('.ai-agent-thread'));
    assert.match(await page.locator('.ai-agent-welcome h2').innerText(), /想了解 贵州茅台/);

    await page.locator('.ai-agent-memory summary').click();
    await page.getByLabel('我的分析偏好').fill('我做短线，单笔止损 5%');
    await page.locator('.ai-agent-memory').getByRole('button', { name: '保存偏好' }).click();
    await page.locator('.ai-agent-memory').getByRole('button', { name: '已保存' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.settings.at(-1)), { memory: '我做短线，单笔止损 5%' });
    assert.match(await page.locator('.ai-agent-memory summary').innerText(), /已设置/);

    // 持仓诊断只填进输入框，光标停在成本价处。
    await page.getByRole('button', { name: /^持仓诊断/ }).click();
    assert.match(await page.getByRole('textbox', { name: '向 AI 提问' }).inputValue(), /成本价 元/);
    assert.equal((await page.evaluate(() => window.calls.start)).length, 1, 'holding diagnosis waits for the cost price');
    await page.getByRole('button', { name: /看个股详情/ }).click();
    assert.deepEqual(await page.evaluate(() => window.calls.opened), ['600519']);
  }));

  test('a failed answer can be retried and an unconfigured model is explained up front', async () => {
    await pageTest(async page => {
      await page.getByRole('button', { name: /^今日市场/ }).click();
      await page.locator('.ai-agent-msg.failed').waitFor();
      assert.match(await page.locator('.ai-agent-msg.failed').innerText(), /HTTP 429/);
      await page.locator('.ai-agent-msg.failed').getByRole('button', { name: '重试' }).click();
      await page.waitForFunction(() => window.calls.start.length === 2);
      const retry = await page.evaluate(() => window.calls.start[1]);
      assert.match(retry.message, /今天A股短线情绪怎么样/);
    }, '?fail=1');
    await pageTest(async page => {
      await page.locator('.warning-banner').first().waitFor();
      assert.match(await page.locator('.warning-banner').first().innerText(), /还没有可用的 AI 模型配置/);
      assert.equal(await page.getByRole('textbox', { name: '向 AI 提问' }).isDisabled(), true);
      assert.equal(await page.getByRole('button', { name: /^今日市场/ }).isDisabled(), true);
    }, '?configured=0');
  });

  test('narrow windows stack the conversation list above the chat without horizontal scrolling', async () => pageTest(async page => {
    await pickStock(page);
    await page.getByRole('button', { name: /^全面分析/ }).click();
    await page.locator('.ai-agent-msg.assistant:not(.running) .agent-markdown').waitFor();
    const layout = await page.evaluate(() => {
      const side = document.querySelector('.ai-agent-sidebar').getBoundingClientRect(), chat = document.querySelector('.ai-agent-chat').getBoundingClientRect();
      return { overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth, stacked: chat.top >= side.bottom - 1, chatWidth: chat.width };
    });
    assert.ok(layout.overflow <= 1 && layout.stacked && layout.chatWidth > 600, JSON.stringify(layout));
    await page.screenshot({ path: path.join(screenshotDir, 'answer-light-1024.png'), animations: 'disabled' });
  }, '', { width: 1024, height: 900 }));

  test('analysis skills: pick up to three, see them on the question and a verdict per skill on the answer', async () => pageTest(async page => {
    const bar = page.locator('.ai-agent-skillbar');
    assert.match(await bar.innerText(), /自动（AI 自己决定怎么分析）/);
    await bar.getByRole('button', { name: '选择打法' }).click();
    const panel = page.getByRole('group', { name: '选择分析打法' });
    for (const group of ['短线情绪', '波段趋势', '量价技术', '消息资金', '持仓风控', '我的打法']) assert.equal(await panel.getByRole('region', { name: group }).count(), 1, group);
    assert.ok(await panel.locator('.ai-agent-skill-pick').count() >= 19);
    for (const name of ['低吸回踩', '风险收益比', '量价分析']) await panel.locator('.ai-agent-skill-pick').filter({ hasText: name }).first().click();
    // 已选满 3 种：其他打法暂时不能再选。
    assert.equal(await panel.locator('.ai-agent-skill-pick').filter({ hasText: '趋势跟随' }).isDisabled(), true);
    assert.deepEqual(await page.evaluate(() => window.calls.settings.at(-1).skillIds), ['pullback_low', 'risk_reward', 'volume_price'], 'the choice is remembered');
    await bar.locator('.ai-agent-skill-chip').filter({ hasText: '量价分析' }).getByRole('button').click();
    assert.equal(await bar.locator('.ai-agent-skill-chip').count(), 2);
    assert.equal(await panel.locator('.ai-agent-skill-pick').filter({ hasText: '趋势跟随' }).isDisabled(), false);
    await bar.getByRole('button', { name: '收起' }).click();
    await pickStock(page);
    assert.match(await page.locator('.ai-agent-welcome').innerText(), /按「低吸回踩」「风险收益比」的打法分析/);
    await page.getByRole('button', { name: /^全面分析/ }).click();
    await page.locator('.ai-agent-msg.assistant:not(.running) .ai-agent-verdicts').waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.start.at(-1).skillIds), ['pullback_low', 'risk_reward']);
    assert.match(await page.locator('.ai-agent-msg.user small').last().innerText(), /打法：低吸回踩、风险收益比/);
    const verdicts = page.locator('.ai-agent-verdicts li');
    assert.equal(await verdicts.count(), 2);
    assert.match(await verdicts.first().innerText(), /低吸回踩\s*接近\s*缩量回调/);
    assert.equal(await verdicts.nth(1).locator('.ai-agent-verdict.no').count(), 1);
    await page.screenshot({ path: path.join(screenshotDir, 'skills-answer-light-1480.png'), animations: 'disabled' });
    await page.evaluate(() => document.documentElement.dataset.theme = 'dark');
    await bar.getByRole('button', { name: '更换打法' }).click();
    await page.screenshot({ path: path.join(screenshotDir, 'skills-panel-dark-1480.png'), animations: 'disabled' });
  }));

  test('custom skills: create, use, edit and delete my own analysis method', async () => pageTest(async page => {
    const bar = page.locator('.ai-agent-skillbar');
    await bar.getByRole('button', { name: '选择打法' }).click();
    const mine = page.getByRole('region', { name: '我的打法' });
    await mine.getByRole('button', { name: '新建我的打法' }).click();
    const editor = page.getByRole('form', { name: '新建我的打法' });
    await editor.getByRole('button', { name: '保存打法' }).click();
    assert.match(await editor.getByRole('alert').innerText(), /起个名字/);
    await editor.getByLabel('打法名称').fill('低吸回踩');
    await editor.getByLabel('打法判断要点').fill('尾盘缩量回踩分时均价线\n次日冲高 3% 卖出');
    await editor.getByRole('checkbox', { name: '公司公告' }).check();
    await editor.getByRole('button', { name: '保存打法' }).click();
    assert.match(await editor.getByRole('alert').innerText(), /已经有叫「低吸回踩」的打法了/);
    await editor.getByLabel('打法名称').fill('尾盘低吸');
    await editor.getByRole('button', { name: '保存打法' }).click();
    await mine.locator('.ai-agent-skill-pick').filter({ hasText: '尾盘低吸' }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.calls.skillSave.at(-1).tools), ['kline', 'intraday', 'announcements']);
    assert.equal(await mine.locator('.ai-agent-skill-pick').filter({ hasText: '尾盘低吸' }).getAttribute('aria-pressed'), 'true', 'a new skill is selected right away');
    assert.match(await mine.locator('.ai-agent-skill-pick').filter({ hasText: '尾盘低吸' }).innerText(), /看：近期K线、当日分时、公司公告/);
    await mine.getByRole('button', { name: '修改「尾盘低吸」' }).click();
    const edit = page.getByRole('form', { name: '修改我的打法' });
    assert.equal(await edit.getByLabel('打法名称').inputValue(), '尾盘低吸');
    await edit.getByLabel('打法判断要点').fill('尾盘缩量回踩分时均价线，次日冲高卖出');
    await edit.getByRole('button', { name: '保存打法' }).click();
    await mine.locator('.ai-agent-skill-pick').filter({ hasText: '尾盘缩量回踩分时均价线，次日冲高卖出' }).waitFor();
    await mine.getByRole('button', { name: '删除「尾盘低吸」' }).click();
    await mine.getByRole('button', { name: '确认删除「尾盘低吸」' }).click();
    await page.waitForFunction(() => window.calls.skillRemove.length === 1);
    assert.equal(await mine.locator('.ai-agent-skill-pick').count(), 0);
    assert.equal(await bar.locator('.ai-agent-skill-chip').count(), 0, 'a deleted skill leaves the selection');
  }));
});
