"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let App;
let NewsView;
let PreviousLimitUpFailedBoards;
let selectFailedBoardDay;
let FailedBoardDayTabs;
let mergeGoodFailedBoardDays;
let failedBoardDaysForDisplay;
let failedBoardSessionLabel;
let resolveInformationCenterRoute;
let priceChartSeries;
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
  NewsView = require("./features/information/NewsView.tsx").NewsView;
  const failedBoardModule = require("./PreviousLimitUpFailedBoards.tsx");
  PreviousLimitUpFailedBoards = failedBoardModule.default;
  selectFailedBoardDay = failedBoardModule.selectFailedBoardDay;
  FailedBoardDayTabs = failedBoardModule.FailedBoardDayTabs;
  mergeGoodFailedBoardDays = failedBoardModule.mergeGoodFailedBoardDays;
  failedBoardDaysForDisplay = failedBoardModule.failedBoardDaysForDisplay;
  failedBoardSessionLabel = failedBoardModule.failedBoardSessionLabel;
  resolveInformationCenterRoute = appModule.resolveInformationCenterRoute;
  priceChartSeries = require("./priceChartSeries.ts");
});

test("failed-board view defaults to one independent latest day and exposes five daily selectors", () => {
  const dates = ["2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13", "2026-10-12"];
  const daily = dates.map((date, index) => ({
    date,
    status: "ready",
    rows: [{
      code: `60000${index + 1}`,
      name: `仅${date}炸板`,
      industry: "示例行业",
      consecutiveBoards: 1,
      firstSealTime: "09:32:00",
      lastSealTime: "10:12:00",
      openBoardCount: 1,
      latest: 10,
      changePct: 2 + index,
      amount: 100_000_000,
      turnover: 2
    }],
    source: { providers: ["preview"], requestedDate: date, sourceLatestDate: dates[0], fetchedAt: "2026-10-16T08:00:00.000Z" },
    error: null
  }));
  const snapshot = {
    status: "ready", currentDate: dates[0], previousDate: dates[1], failedBoardDays: daily,
    rows: [{
      code: "600099", name: "仅旧交集", industry: "示例行业",
      previous: { consecutiveBoards: 1, firstSealTime: "09:30:00", lastSealTime: "09:30:00", openBoardCount: 0, boardType: "换手板", isOneWordBoard: false },
      today: { latest: 10, changePct: 1, amount: 100_000_000, turnover: 2, firstSealTime: "09:32:00", lastSealTime: "10:12:00", openBoardCount: 1 }
    }],
    sources: { previousLimitUp: null, todayFailed: null }, errors: { previousLimitUp: null, todayFailed: null },
    checkedAt: "2026-10-16T08:00:00.000Z", isPreview: true
  };
  const html = renderToStaticMarkup(React.createElement(PreviousLimitUpFailedBoards, {
    live: false,
    cache: { latestResponse: snapshot, lastGoodSnapshot: snapshot, lastGoodDailyDays: daily, failureMessage: "", lastAttemptAt: null },
    onSnapshot() {},
    onOpen() {},
    onAdd() {},
    isFavorite: () => false
  }));

  assert.match(html, /role="tablist" aria-label="炸板数据视图"/);
  assert.match(html, /role="tab" aria-selected="true"[^>]*>当日炸板/);
  assert.ok(html.includes(dates[0]));
  for (const date of dates.slice(1)) assert.equal(html.includes(date), false, `default view mixed in ${date}`);
  assert.match(html, /仅2026-10-16炸板/);
  assert.match(html, /class="puf-sort-button"[^>]*>开板次数/);
  assert.doesNotMatch(html, /仅2026-10-15炸板|仅旧交集/);
  assert.equal(selectFailedBoardDay(daily, "today").date, dates[0]);
  assert.equal(selectFailedBoardDay(daily, "five-days", dates[2]).date, dates[2]);
  assert.deepEqual(selectFailedBoardDay(daily, "five-days", dates[2]).rows.map((row) => row.name), [`仅${dates[2]}炸板`]);
  const dayTabs = renderToStaticMarkup(React.createElement(FailedBoardDayTabs, { days: daily, selectedDate: dates[2], onSelect() {} }));
  assert.equal((dayTabs.match(/role="tab"/g) || []).length, 5);
  assert.match(dayTabs, new RegExp(`aria-selected="true"><span>${dates[2]}</span><strong>1 只</strong>`));
  const selectedDates = [];
  const dayTabElement = FailedBoardDayTabs({ days: daily, selectedDate: dates[0], onSelect: (date) => selectedDates.push(date) });
  dayTabElement.props.children[2].props.onClick();
  assert.deepEqual(selectedDates, [dates[2]]);
});

test("last-good daily snapshots retain each successful date across partial results and request failures", () => {
  const days = ["2026-10-16", "2026-10-15", "2026-10-14"].map(date => ({
    date, status: "ready", rows: [{ code: "600001", name: date }], source: null, error: null
  }));
  const partial = [{ date: days[0].date, status: "unavailable", rows: [], source: null, error: "源失败" }];
  const retained = mergeGoodFailedBoardDays(days, partial);

  assert.deepEqual(retained.map(day => day.date), days.map(day => day.date));
  assert.deepEqual(retained.map(day => day.rows[0].name), days.map(day => day.rows[0].name));
  assert.deepEqual(mergeGoodFailedBoardDays(retained, []), retained, "a later global request failure must leave per-day successes available");
  assert.deepEqual(failedBoardDaysForDisplay(null, retained), retained);
  assert.ok(failedBoardDaysForDisplay({ failedBoardDays: [] }, retained).every(day => day.staleReason));
  const [fallback] = failedBoardDaysForDisplay({ failedBoardDays: partial }, retained);
  assert.equal(fallback.date, partial[0].date);
  assert.equal(fallback.status, "ready");
  assert.deepEqual(fallback.rows, days[0].rows);
  assert.equal(fallback.staleReason, "源失败");
  assert.deepEqual(failedBoardDaysForDisplay({ failedBoardDays: partial }, []).map(day => day.status), ["unavailable"]);
  const confirmedEmpty = { ...days[0], rows: [] };
  assert.deepEqual(failedBoardDaysForDisplay({ failedBoardDays: [confirmedEmpty] }, retained), [confirmedEmpty]);
  const nextDay = { date: "2026-10-19", status: "unavailable", rows: [], source: null, error: "源失败" };
  assert.deepEqual(failedBoardDaysForDisplay({ failedBoardDays: [nextDay] }, retained), [nextDay]);
});

test("failed-board close status requires a snapshot fetched after the same trading day's close", () => {
  const date = "2026-10-16";
  assert.equal(failedBoardSessionLabel(date, "2026-10-16T06:55:00Z", new Date("2026-10-17T01:00:00Z")), "盘中快照");
  assert.equal(failedBoardSessionLabel(date, "2026-10-16T06:55:00Z", new Date("2026-10-16T06:59:00Z")), "盘中暂未回封");
  assert.equal(failedBoardSessionLabel(date, "2026-10-16T07:05:00Z", new Date("2026-10-16T07:10:00Z")), "收盘未回封");
  assert.equal(failedBoardSessionLabel(date, "2026-10-17T01:00:00Z"), "收盘未回封");
  assert.equal(failedBoardSessionLabel(date, null), "快照时点未知");
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

  assert.match(html, /class="app-shell(?:\s[^"]*)?"/);
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
  assert.ok((html.match(/class="nav-item/g) || []).length >= 10);
  assert.match(html, /aria-label="AI 选股"/);
});

test("App retains the named NewsView compatibility export", () => {
  assert.equal(typeof require("./App.tsx").NewsView, "function");
});

test("memoizable price chart series preserve the established moving-average and Bollinger formulas", () => {
  const rows = Array.from({ length: 80 }, (_, index) => ({
    close: 10 + index * 0.03 + (index % 7) * 0.2,
    volume: 1000 + index * 13
  }));
  const referenceAverage = (days, index, field = "close") => {
    if (index + 1 < days) return Number.NaN;
    const window = rows.slice(index - days + 1, index + 1);
    return window.reduce((sum, item) => sum + Number(item[field] || 0), 0) / days;
  };
  const moving = priceChartSeries.calculatePriceMovingAverages(rows);
  for (const [key, days] of [["ma5", 5], ["ma10", 10], ["ma20", 20], ["ma60", 60]]) {
    for (let index = 0; index < rows.length; index += 1) {
      const actual = moving[key][index];
      const expected = referenceAverage(days, index);
      if (Number.isNaN(expected)) assert.equal(Number.isNaN(actual), true);
      else assert.ok(Math.abs(actual - expected) < 1e-12);
    }
  }
  const bands = priceChartSeries.calculateBollingerBands(rows, moving.ma20);
  for (let index = 0; index < rows.length; index += 1) {
    if (index < 19) {
      assert.equal(Number.isNaN(bands.upper[index]), true);
      assert.equal(Number.isNaN(bands.lower[index]), true);
      continue;
    }
    const mean = moving.ma20[index];
    const window = rows.slice(index - 19, index + 1);
    const deviation = Math.sqrt(window.reduce((sum, row) => sum + (row.close - mean) ** 2, 0) / 20);
    assert.ok(Math.abs(bands.upper[index] - (mean + deviation * 2)) < 1e-12);
    assert.ok(Math.abs(bands.lower[index] - (mean - deviation * 2)) < 1e-12);
  }
  assert.deepEqual(priceChartSeries.calculateBollingerBands(rows, moving.ma20, false), { upper: [], lower: [] });
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

test("opens the unified strategy selection workspace and does not advertise unrelated strategy controls", () => {
  const html = renderToStaticMarkup(React.createElement(App));
  assert.match(html, /data-workspace="signals"/);
  assert.match(html, /aria-current="page"[^>]*>[\s\S]*?策略选股/);
  assert.doesNotMatch(html, />涨停趋势</, "the former trend entry is merged into 策略选股");
  assert.doesNotMatch(html, /近期涨停 · 趋势向上|2–6 周 · A股波段工作台/);
  assert.doesNotMatch(html, /class="brand"/);
  assert.doesNotMatch(html, /strategy-quick-trigger/);
  assert.doesNotMatch(html, /行情监控运行中/);
});

test("one-click close-all moves every open position into closed (B2-01)", () => {
  const appModule = require("./App.tsx");
  const { shanghaiDateTag } = require("./dateUtils.ts");
  const settings = require("./domain/settings.ts").initialSettings;
  const today = shanghaiDateTag();
  const yesterday = shanghaiDateTag(new Date(Date.now() - 86_400_000));
  // 两只可撮合的持仓：T+1 已过、今日行情/前收/量齐备、未涨跌停、无除权阻塞。
  const openPosition = (code) => ({
    id: `sim-${code}`, code, name: `示例${code}`, shares: 1000,
    entryPrice: 10, latestPrice: 10.5, stopPrice: 9, takePrice: 12, holdingBars: 2,
    entryFee: 5, feeRatePercent: 0.03, openedAt: yesterday, planSignal: "BUY",
    highWaterMark: 10.5, strategySignature: "sig", riskProfile: "balanced",
    strategyIds: ["support"], entryReadinessScore: 70, entryExecutionFillRatePercent: 90,
    quoteDate: today, quoteVolume: 1_000_000, quotePreClose: 10, quoteName: `示例${code}`,
    settlementBlockedReason: ""
  });
  const state = {
    initialCapital: 200000, cash: 0, lastOpenAt: "", dailyRealizedPnl: 0,
    lastTradeDate: today, totalTradeCount: 0, closedPositions: [],
    openPositions: [openPosition("600001"), openPosition("600002")]
  };

  const action = appModule.closeAllPaperTradesAction(state, "MANUAL", settings);
  assert.equal(action.changed, true, "closing two eligible positions must report a change");
  assert.equal(action.state.openPositions.length, 0, "all open positions must be closed");
  assert.deepEqual(
    action.state.closedPositions.map((item) => item.code).sort(),
    ["600001", "600002"],
    "both positions must be recorded as closed"
  );
  assert.match(action.message, /已平 2 笔/);
  for (const item of action.state.closedPositions) {
    assert.equal(item.closeReason, "MANUAL");
    assert.ok(Number.isFinite(item.realizedPnl) && item.realizedPnl > 0, "10.5 vs 10 entry must book a profit");
  }

  // 空仓时不得伪造一笔“已平”。
  const empty = appModule.closeAllPaperTradesAction({ ...state, openPositions: [] }, "MANUAL", settings);
  assert.equal(empty.changed, false);
  assert.equal(empty.state.closedPositions.length, 0);
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
