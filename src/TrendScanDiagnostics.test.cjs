'use strict';
const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');
const { registerTypeScript } = require('../qa/register-typescript.cjs');
let restore, Diagnostics;
before(() => { restore = registerTypeScript(); Diagnostics = require('./TrendScanDiagnostics.tsx').default; });
after(() => restore?.());
test('unstarted and older snapshots cannot pretend to have measured zero passes', () => {
  assert.equal(renderToStaticMarkup(React.createElement(Diagnostics, { status: null })), '');
  const html = renderToStaticMarkup(React.createElement(Diagnostics, { status: { phase:'completed' } }));
  assert.match(html, /本次快照未记录分层诊断/);
  assert.doesNotMatch(html, /data-funnel-stage/);
});
test('partial scans show stock counts and failed data sources rather than a no-opportunity verdict', () => {
  const html = renderToStaticMarkup(React.createElement(Diagnostics, { status: {
    phase:'completed', coverageComplete:false,
    diagnostics:{funnel:{universeEligible:120,rawValidated:100,recentLimitPassed:20,trendPassed:8,technicalTriggered:3,riskPassed:1},
      sources:[{stage:'raw',source:'搜狐',status:'ok',successes:100,failures:0,latestDate:'2026-09-30',detail:'量额已核对',crossCheckedRows:320},
        {stage:'adjusted',source:'腾讯',status:'error',successes:0,failures:2,latestDate:null,detail:'缺少明确复权序列',crossCheckedRows:0}],
      reasons:[{stage:'data',reason:'复权不可验证',count:2}]}
  } }));
  assert.equal((html.match(/data-funnel-stage=/g)||[]).length, 6);
  assert.match(html, /部分数据/);assert.match(html, /缺少明确复权序列/);assert.match(html,/交叉核对 320 行/);
  assert.doesNotMatch(html, /全市场没有机会|全市场覆盖完整/);
});
