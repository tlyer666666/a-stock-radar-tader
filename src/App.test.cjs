"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let App;
let NewsView;
let resolveInformationCenterRoute;
let restoreTypeScript;
let previousCssLoader;
let previousWindow;

before(() => {
  previousCssLoader = require.extensions[".css"];
  require.extensions[".css"] = () => {};
  previousWindow = global.window;
  global.window = { stockApi: { getPlatform: () => "win32" } };
  restoreTypeScript = registerTypeScript();
  const appModule = require("./App.tsx");
  App = appModule.default;
  NewsView = appModule.NewsView;
  resolveInformationCenterRoute = appModule.resolveInformationCenterRoute;
});

after(() => {
  restoreTypeScript?.();
  if (previousCssLoader) require.extensions[".css"] = previousCssLoader;
  else delete require.extensions[".css"];
  if (previousWindow === undefined) delete global.window;
  else global.window = previousWindow;
});

test("renderer initial shell exposes navigation, window controls and risk notice", () => {
  const html = renderToStaticMarkup(React.createElement(App));

  assert.match(html, /class="app-shell(?:\s[^\"]*)?"/);
  assert.match(html, /data-window-controls="true"/);
  assert.match(html, /aria-label="最小化窗口"/);
  assert.match(html, /aria-label="最大化窗口"/);
  assert.match(html, /aria-label="关闭窗口"/);
  assert.match(html, /data-window-action="minimize"/);
  assert.match(html, /data-window-action="toggle-maximize"/);
  assert.match(html, /data-window-action="close"/);
  assert.match(html, /aria-label="证券搜索：A股、ETF、可转债"/);
  assert.match(html, /data-professional-review-nav="true"/);
  assert.equal((html.match(/data-information-center-nav="true"/g) || []).length, 1);
  assert.doesNotMatch(html, /data-announcements-nav/);
  assert.doesNotMatch(html, /aria-label="(?:资讯雷达|A股公告)"/);
  assert.match(html, /data-backtest-nav="true"/);
  assert.match(html, /专业复盘/);
  assert.match(html, /仅供研究，不构成投资建议/);
  assert.ok((html.match(/class="nav-item/g) || []).length >= 9);
});

test("information center defaults to all and legacy announcements selects disclosure tab", () => {
  assert.deepEqual(resolveInformationCenterRoute("news"), { view: "news", informationTab: "all" });
  assert.deepEqual(resolveInformationCenterRoute("announcements"), { view: "news", informationTab: "announcement" });
  assert.deepEqual(resolveInformationCenterRoute("news", "flash"), { view: "news", informationTab: "flash" });
});

test("information center exposes three tabs and keeps disclosure-specific filters", () => {
  const render = (contentType) => renderToStaticMarkup(React.createElement(NewsView, {
    payload: null, watchlist: [], holdings: [], limitUps: [], settings: {},
    ...(contentType ? { contentType } : {}), onContentTypeChange() {}, onOpenStock() {}
  }));
  const all = render();
  assert.match(all, /资讯中心/);
  assert.match(all, /role="tablist" aria-label="资讯类型"/);
  assert.match(all, /role="tab" aria-selected="true"[^>]*>全部/);
  assert.match(all, /role="tab" aria-selected="false"[^>]*>市场资讯/);
  assert.match(all, /role="tab" aria-selected="false"[^>]*>公司公告/);
  assert.doesNotMatch(all, /全部重要性/);
  const announcement = render("announcement");
  assert.match(announcement, /role="tab" aria-selected="true"[^>]*>公司公告/);
  for (const label of ["全部重要性", "更正/修订", "全部类型", "公告判定规则", "观察池", "持仓股", "当前个股", "立即刷新"]) assert.ok(announcement.includes(label), label);
  const flash = render("flash");
  assert.match(flash, /role="tab" aria-selected="true"[^>]*>市场资讯/);
  assert.doesNotMatch(flash, /全部重要性/);
});

test("opens the user's trend workflow and does not advertise unrelated strategy controls", () => {
  const html = renderToStaticMarkup(React.createElement(App));
  assert.match(html, /data-workspace="trend-screener"/);
  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?涨停趋势/);
  assert.doesNotMatch(html, /近期涨停 · 趋势向上|2–6 周 · A股波段工作台/);
  assert.doesNotMatch(html, /class="brand"/);
  assert.doesNotMatch(html, /strategy-quick-trigger/);
  assert.doesNotMatch(html, /行情监控运行中/);
});

test('research loaders recover semantic backups without writing and keep valid or empty primary',()=>{
 const m=require('./App.tsx'),settings=require('./domain/settings.ts').initialSettings;
 const log={id:'keep-log',source:'BACKTEST_CURRENT',result:'BLOCKED'},history={id:'keep-history',securityCode:'600001'},paper={initialCapital:100000,cash:77700,openPositions:[],closedPositions:[]};
 const previous=global.window;
 try{
  for(const [key,bad,good,load,pick] of [
   ['a-stock-radar-v054-execution-decision-log-v1',[{}],[log],m.loadExecutionDecisionLog,x=>x[0]?.id],
   ['a-stock-radar-v054-backtest-history-v1',[{}],[history],()=>m.loadBacktestHistory(settings),x=>x[0]?.id],
   ['a-stock-radar-v054-paper-sim-v1',{},paper,m.loadPaperState,x=>x.cash]]){
    const data=new Map([[key,JSON.stringify(bad)],[key+':last-good',JSON.stringify(good)]]);global.window={...previous,localStorage:{getItem:k=>data.get(k)??null,setItem(){throw Error('read mutated');}}};
    assert.equal(pick(load()),pick(good));assert.equal(data.get(key),JSON.stringify(bad));
    if(Array.isArray(good)){data.set(key,'[]');assert.deepEqual(load(),[]);data.set(key,JSON.stringify([null,...good]));assert.equal(pick(load()),pick(good));}
  }
 }finally{global.window=previous;}
});
