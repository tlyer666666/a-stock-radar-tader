'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createPreview, openView } = require('./frontend-v150.cjs');

test('AI 选股标明基础分及模型缺口，补齐仅提交缺失股票', async () => {
  const app = await createPreview();
  const page = await app.browser.newPage({ viewport: { width: 1440, height: 950 } });
  try {
    await page.goto(app.url);
    await page.locator('.workspace-navigation').waitFor();
    await page.evaluate(async () => {
      const { setSelectionReport } = await import('/src/features/strategy-selection/selectionReportStore.ts');
      setSelectionReport({ asOfDate: '2026-11-12', strategies: [{ id: 'qa', name: '样例策略', stocks: [
        { code: '600519', name: '样例甲' }, { code: '000001', name: '样例乙' }, { code: '300750', name: '样例丙' }
      ] }] });
      const scores = [{ id: 'a', name: '样例模型 A', score: 72, rating: '关注' }, { id: 'b', name: '样例模型 B', score: 74, rating: '关注' }];
      const models = scores.map(model => ({ id: model.id, name: model.name, model: model.name, ok: true }));
      const ranking = {
        asOfDate: '2026-11-12', model: '样例', generatedAt: '2026-11-13T03:00:00Z', evaluated: 2, models,
        items: [
          { code: '600519', name: '样例甲', score: 73, rating: '关注', scores },
          { code: '000001', name: '样例乙', score: 72, rating: '关注', scores: scores.slice(0, 1) },
          { code: '300750', name: '样例丙', score: 86, rating: '重点关注', fallback: true, scores: [] }
        ]
      };
      window.stockApi.ai = {
        status: async () => ({ configured: true, model: '样例', rankModels: ['A', 'B'] }),
        cached: async () => ({ rank: ranking, summary: null }),
        rank: async input => {
          window.qaRankInput = input;
          return { ...ranking, evaluated: 3, items: ranking.items.map(item => ({ ...item, fallback: false, scores })) };
        }
      };
    });
    await openView(page, 'ai-picks', 'AI 选股');
    await page.getByText('仅基础分', { exact: true }).waitFor();
    await page.getByText('模型已返回 1/2', { exact: true }).waitFor();
    assert.match(await page.getByLabel('AI 控制条').innerText(), /已齐 1 只.*还差 2 只/);
    await page.getByRole('button', { name: '补齐 2 只打分', exact: true }).click();
    await page.getByRole('button', { name: '全部重新打分', exact: true }).waitFor();
    const request = await page.evaluate(() => window.qaRankInput);
    assert.equal(request.force, false);
    assert.deepEqual(request.only.sort(), ['000001', '300750']);
  } finally { await page.close(); await app.close(); }
});
