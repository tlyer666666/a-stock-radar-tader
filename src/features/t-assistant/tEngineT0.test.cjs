"use strict";
// 做T助手对 T+0 场内基金（跨境、商品、债券、货币 ETF）的支持。
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let engine, rule, store;
let restoreTypeScript;
before(() => {
  restoreTypeScript = registerTypeScript();
  engine = require("./tEngine.ts");
  rule = require("../../domain/etfTradingRule.ts");
  store = require("./tStore.ts");
});
after(() => restoreTypeScript?.());

const slotTime = slot => {
  const minutes = slot <= 120 ? 9 * 60 + 30 + slot : 13 * 60 + (slot - 120);
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
};
function share(prices, { preClose = prices[0] } = {}) {
  let sum = 0;
  const points = prices.map((price, slot) => {
    sum += price;
    return { slot, time: slotTime(slot), price, average: sum / (slot + 1), volume: 100, amount: null, changePercent: (price / preClose - 1) * 100, rising: true };
  });
  return { date: "2026-11-19", preClose, preCloseSource: "source", points, high: Math.max(...prices), low: Math.min(...prices), scale: { min: 0, max: 2, maxPercent: 10 }, totalVolume: 0, totalAmount: null };
}
const ETF = { code: "513180", name: "恒生科技ETF华夏" };
const etfConfig = (overrides = {}) => engine.normalizeTConfig({ baseShares: 0, sellableShares: 0, tShares: 20000, minSpreadPct: 0.5, ...overrides }, ETF.code);

test("交易规则识别：跨境、商品、债券、货币 ETF 为 T+0，股票和 A 股股票型 ETF 为 T+1", () => {
  for (const [code, name] of [["513180", "恒生科技ETF华夏"], ["159920", "恒生ETF华夏"], ["518880", "黄金ETF华安"], ["159934", "黄金ETF易方达"], ["511260", "十年国债ETF国泰"],
    ["511880", "银华日利ETF"], ["159985", "豆粕ETF华夏"], ["513630", "XD港股低波红利ETF摩根"], ["159941", "纳指ETF广发"], ["511380", "可转债ETF博时"]]) {
    assert.equal(rule.detectT0(code, name), true, `${code} ${name}`);
  }
  for (const [code, name] of [["600519", "贵州茅台"], ["510300", "沪深300ETF华泰柏瑞"], ["159915", "创业板ETF易方达"], ["517520", "黄金股ETF永赢"],
    ["512400", "有色金属ETF南方"], ["159201", "自由现金流ETF华夏"], ["517000", "沪港深500ETF某某"]]) {
    assert.equal(rule.detectT0(code, name), false, `${code} ${name}`);
  }
  assert.equal(rule.resolveT0("510300", "沪深300ETF", "t0"), true, "手动指定优先");
  assert.equal(rule.resolveT0("513180", "恒生科技ETF", "t1"), false);
  assert.equal(rule.priceTickOf("513180"), 0.001);
  assert.equal(rule.priceTickOf("600519"), 0.01);
});

test("配置保存交易规则，非法值回落为自动识别", () => {
  assert.equal(engine.normalizeTConfig({ tradingRule: "t0" }, "510300").tradingRule, "t0");
  assert.equal(engine.normalizeTConfig({ tradingRule: "x" }, "510300").tradingRule, "auto");
  assert.equal(engine.normalizeTConfig({}, "600000").tradingRule, "auto");
});

test("场内基金免印花税和过户费：同样一卖一买，手续费比股票少", () => {
  const trades = [
    { id: "1", side: "sell", price: 10.5, shares: 10000, time: "10:05" },
    { id: "2", side: "buy", price: 10.2, shares: 10000, time: "13:40" }
  ];
  const cfg = engine.normalizeTConfig({ baseShares: 10000, sellableShares: 10000, commissionPercent: 0.025 }, "513180");
  const fund = engine.settleTrades(trades, cfg, "513180").stats.fees;
  const stock = engine.settleTrades(trades, cfg, "600000").stats.fees;
  assert.ok(Math.abs(fund - (10.5 * 10000 * 0.00025 + 10.2 * 10000 * 0.00025)) < 1e-6, `基金只收佣金 ${fund}`);
  assert.ok(stock - fund > 50, `股票多出印花税和过户费 ${stock - fund}`);
});

test("T+0 没有底仓也能先买后卖：下探企稳给低吸，买入后当天就能卖出", () => {
  const prices = [...Array.from({ length: 60 }, () => 0.72), ...Array.from({ length: 20 }, (_, i) => Number((0.72 - i * 0.0012).toFixed(3))), 0.6975, 0.698, 0.699];
  const opened = engine.analyzeT(share(prices), ETF, etfConfig(), []);
  assert.equal(opened.t0, true);
  assert.equal(opened.priceDigits, 3);
  assert.equal(opened.signal.action, "buy", JSON.stringify(opened.signal));
  assert.equal(opened.signal.shares, 20000);

  const after = [...prices, ...Array.from({ length: 25 }, (_, i) => Number((0.699 + i * 0.001).toFixed(3))), 0.725, 0.724, 0.723];
  const closing = engine.analyzeT(share(after), ETF, etfConfig(), [{ id: "b", side: "buy", price: 0.698, shares: 20000, time: "10:52" }]);
  assert.equal(closing.open.kind, "forward");
  assert.equal(closing.signal.action, "sellBack", JSON.stringify(closing.signal));
  assert.equal(closing.signal.shares, 20000, "T+0：当天买入的份额全部可卖");
  assert.equal(closing.signal.title, "卖出");
  assert.match(closing.signal.reasons.join(" "), /0\.\d{3}/, "价格按 0.001 显示");

  const t1 = engine.analyzeT(share(after), ETF, etfConfig({ tradingRule: "t1" }), [{ id: "b", side: "buy", price: 0.698, shares: 20000, time: "10:52" }]);
  assert.equal(t1.signal.action, "wait", "同样的成交按 T+1 当天不能卖");
  assert.equal(t1.signal.title, "没有可卖底仓");
});

test("T+0 倒T接回后，买回的份额当天可再卖；T+1 则不行", () => {
  const prices = Array.from({ length: 150 }, (_, i) => Number((0.72 + 0.012 * Math.sin(i / 8)).toFixed(3)));
  const trades = [
    { id: "s", side: "sell", price: 0.73, shares: 10000, time: "10:00" },
    { id: "b", side: "buy", price: 0.715, shares: 10000, time: "10:40" }
  ];
  const cfg = { baseShares: 10000, sellableShares: 10000, tShares: 10000, minSpreadPct: 0.5 };
  const t0 = engine.analyzeT(share(prices), ETF, etfConfig(cfg), trades);
  assert.notEqual(t0.signal.title, "可卖底仓已用完");
  const t1 = engine.analyzeT(share(prices), ETF, etfConfig({ ...cfg, tradingRule: "t1" }), trades);
  assert.equal(t1.signal.title, "可卖底仓已用完");
});

test("T+0 没有可卖份额时不提示先卖，没填做T股数时提示填写", () => {
  const empty = engine.analyzeT(share(Array.from({ length: 80 }, () => 0.72)), ETF, etfConfig({ tShares: 0 }), []);
  assert.equal(empty.signal.title, "先填做T股数");
  const stock = engine.analyzeT(share(Array.from({ length: 80 }, () => 10)), { code: "600000", name: "浦发银行" }, engine.normalizeTConfig({ baseShares: 0, sellableShares: 0, tShares: 1000 }, "600000"), []);
  assert.equal(stock.signal.title, "先填底仓", "股票仍要求底仓");
  const rising = [...Array.from({ length: 60 }, () => 0.72), ...Array.from({ length: 20 }, (_, i) => Number((0.72 + i * 0.0012).toFixed(3))), 0.7425, 0.742, 0.741];
  const result = engine.analyzeT(share(rising), ETF, etfConfig(), []);
  assert.notEqual(result.signal.action, "sell", "没有底仓不能先卖");
});

test("回放：T+0 没有底仓也能按做T股数回放", () => {
  const prices = Array.from({ length: 200 }, (_, i) => Number((0.72 + 0.012 * Math.sin(i / 9)).toFixed(3)));
  const replay = engine.replayT(share(prices), ETF, etfConfig());
  assert.ok(replay.markers.length > 0);
  assert.ok(replay.markers.every(marker => marker.side === "buy" || marker.label !== "高抛（倒T）"), "没有底仓时回放里不会先卖");
  assert.equal(engine.replayT(share(prices), ETF, etfConfig({ tradingRule: "t1" })).markers.length, 0);
});

test("持久化后的配置保留交易规则", () => {
  const loaded = store.normalizeTStore({ items: [{ code: "513180", name: "恒生科技ETF", config: { baseShares: 0, tShares: 20000, tradingRule: "t0" } }] });
  assert.equal(loaded.items[0].config.tradingRule, "t0");
});

test("useTAssistant, TAssistantView and useTToolbox guard stale items, width zero and offline visibility", async () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const hookSrc = fs.readFileSync(path.join(__dirname, "useTAssistant.ts"), "utf8");
  const viewSrc = fs.readFileSync(path.join(__dirname, "TAssistantView.tsx"), "utf8");
  const toolboxSrc = fs.readFileSync(path.join(__dirname, "useTToolbox.ts"), "utf8");
  assert.match(hookSrc, /storeRef\.current\.items\.some\(entry => entry\.code === item\.code\)/);
  assert.match(hookSrc, /queuedManual\.current\.delete\(code\)/);
  assert.match(viewSrc, /if \(rect\.width <= 0\) return;/);
  assert.match(viewSrc, /if \(isNew\)/);
  assert.match(toolboxSrc, /navigator\.onLine === false\) return;/);

  const { createHookHarness } = require("../../../qa/research-hook-harness.cjs");
  const { useTToolbox } = require("./useTToolbox.ts");
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  const origNavDesc = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  let chartCalls = 0;
  let visibleListener = null;
  globalThis.document = {
    ...(origDocument || {}),
    hidden: false,
    visibilityState: "visible",
    addEventListener: (ev, fn) => { if (ev === "visibilitychange") visibleListener = fn; },
    removeEventListener: () => {}
  };
  globalThis.window = {
    ...(origWindow || {}),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    stockApi: {
      cancelServiceJob: async () => {},
      getChart: async () => {
        chartCalls += 1;
        return { bars: [{ date: "2026-11-24", open: 10, high: 10.5, low: 9.8, close: 10.2, volume: 1000, amount: 10000 }] };
      }
    }
  };
  Object.defineProperty(globalThis, "navigator", { value: { onLine: false }, configurable: true });
  const security = { code: "600519", name: "贵州茅台", secid: "1.600519", assetType: "stock" };
  const h = createHookHarness(() => useTToolbox(security, "60", "front", true));
  try {
    h.render();
    await h.flush();
    assert.equal(chartCalls, 2);
    visibleListener?.();
    await h.flush();
    assert.equal(chartCalls, 2, "offline visibilitychange skips chart reload");
    h.tree.refresh();
    h.render();
    await h.flush();
    assert.equal(chartCalls, 4);

    const { useTAssistant } = require("./useTAssistant.ts");
    const ta = createHookHarness(() => useTAssistant({ live: false, onAlert: () => {} }));
    try {
      ta.render();
      ta.tree.addStock({ code: "600519", name: "贵州茅台" });
      ta.tree.updateConfig("600519", { tShares: 100 });
      ta.tree.setVoice(false);
      ta.tree.setShowReplay(false);
      ta.tree.removeStock("600519");
      await ta.flush();
      assert.equal(ta.tree.store.items.length, 0);
    } finally {
      ta.dispose();
    }
  } finally {
    h.dispose();
    if (origWindow === undefined) delete globalThis.window;
    else globalThis.window = origWindow;
    if (origDocument === undefined) delete globalThis.document;
    else globalThis.document = origDocument;
    if (origNavDesc) Object.defineProperty(globalThis, "navigator", origNavDesc);
  }
});
