const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
const restore = registerTypeScript();
const { simpleAnalysisOrigin, canRefreshAnalysis } = require('./workspaceExperience.ts');
after(restore);

test('global stock search can return to every ordinary workspace including trend, holdings and failed boards', () => {
  for (const view of ['trend-screener', 'previous-limit-up-failed', 'favorites', 'holdings', 'sectors', 'beijing', 'signals', 'compare', 'review', 'settings', 'backtest']) {
    const origin = simpleAnalysisOrigin(view);
    assert.equal(origin.view, view);
    assert.match(origin.label, /^返回/);
  }
  assert.equal(simpleAnalysisOrigin('signals').label, '返回策略选股');
  assert.equal(simpleAnalysisOrigin('trend-screener').label, '返回策略选股', 'the former trend route returns to the merged workspace');
  assert.equal(simpleAnalysisOrigin('watchlist'), null, 'observation node is handled by the caller');
  assert.equal(simpleAnalysisOrigin('news'), null, 'information tab is handled by the caller');
});

test('a hidden previously loaded stock cannot expose its refresh button in another workspace', () => {
  for (const view of ['trend-screener', 'signals', 'sectors', 'holdings', 'previous-limit-up-failed', 'settings']) {
    assert.equal(canRefreshAnalysis(view, 'analysis'), false);
  }
  assert.equal(canRefreshAnalysis('dashboard', 'pool'), false);
  assert.equal(canRefreshAnalysis('dashboard', 'analysis'), true);
});
