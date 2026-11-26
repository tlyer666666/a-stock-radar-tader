"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let restoreTypeScript;
let LimitSealView;
let model;

before(() => {
  restoreTypeScript = registerTypeScript();
  LimitSealView = require("./LimitSealPanel.tsx").LimitSealView;
  model = require("./limitSealModel.ts");
});

after(() => restoreTypeScript?.());

const record = (extra = {}) => ({
  code: "002565", name: "顺灏股份", latest: 8.43, changePct: 10.05, high: 8.43, limitUp: 8.43, limitDown: 6.9, floatMarketCap: 8.94e9,
  status: "sealed", statusLabel: "封死涨停", sealLots: 776288, sealAmount: 776288 * 843, sealFloatRatio: (776288 * 843) / 8.94e9,
  peakAmount: 8e8, fromPeakPct: -18.2, change1mAmount: -1.2e7, change1mPct: -1.8,
  bids: [{ price: 8.43, volumeLots: 776288 }, { price: 8.42, volumeLots: 1943 }], asks: [], source: "同花顺涨停池（封单）+ 腾讯实时五档",
  quoteAt: "2026-11-26T02:37:09.000Z", quoteDate: "2026-11-26",
  history: [{ t: 1, amount: 8e8, status: "sealed" }, { t: 2, amount: 6.6e8, status: "sealed" }],
  ...extra
});

test("seal amounts, lots and warnings read like a trading terminal", () => {
  assert.equal(model.formatSealAmount(6.544e8), "6.54亿");
  assert.equal(model.formatSealAmount(1.89e7), "1,890万");
  assert.equal(model.formatSealAmount(null), "--");
  assert.equal(model.formatLots(776288), "77.6万手");
  assert.equal(model.formatLots(24833), "2.48万手");
  assert.equal(model.formatLots(820), "820手");
  assert.equal(model.sealTone("sealed"), "up");
  assert.equal(model.sealTone("broken"), "warn");
  assert.match(model.sealWarning(record({ change1mPct: -35 })), /1 分钟内减少 35%/);
  assert.match(model.sealWarning(record({ fromPeakPct: -60 })), /较今日峰值回落 60%/);
  assert.match(model.sealWarning(record({ status: "broken" })), /已炸板/);
  assert.equal(model.sealWarning(record()), "");
});

test("ticks merge into the table, keep history from the first read and append new points", () => {
  const first = model.mergeSealTick({}, [record()]);
  assert.equal(first["002565"].history.length, 2);
  const next = model.mergeSealTick(first, [record({ history: undefined, sealLots: 700000, point: { t: 3, amount: 5.9e8, status: "sealed" } })]);
  assert.equal(next["002565"].sealLots, 700000);
  assert.deepEqual(next["002565"].history.map(point => point.t), [1, 2, 3]);
  const same = model.mergeSealTick(next, [record({ history: undefined, point: { t: 3, amount: 5.9e8, status: "sealed" } })]);
  assert.equal(same["002565"].history.length, 3, "the same point is not appended twice");
  assert.equal(model.mergeSealTick(next, []), next);
  assert.ok(model.sealSparkline(next["002565"].history));
  assert.equal(model.sealSparkline([{ t: 1, amount: 1, status: "sealed" }]), null);

  // Fresh subscription without pre-existing history still builds sparkline points and resets across trading days.
  const cold1 = model.mergeSealTick({}, [record({ history: undefined, quoteDate: "2026-11-26", point: { t: 10, amount: 8e8, status: "sealed" } })]);
  assert.equal(cold1["002565"].history.length, 1);
  const cold2 = model.mergeSealTick(cold1, [record({ history: undefined, quoteDate: "2026-11-26", point: { t: 20, amount: 7e8, status: "sealed" } })]);
  assert.deepEqual(cold2["002565"].history.map(p => p.t), [10, 20]);
  assert.ok(model.sealSparkline(cold2["002565"].history), "cold-start detail stock draws sparkline once 2 ticks arrive");
  const nextDay = model.mergeSealTick(cold2, [record({ history: undefined, quoteDate: "2026-11-27", point: { t: 30, amount: 6e8, status: "sealed" } })]);
  assert.deepEqual(nextDay["002565"].history.map(p => p.t), [30], "cross-day tick resets prior day history");

  // Shared bid/ask depth scale: tiny ask1 next to huge bid1 renders narrow bar instead of 100%.
  const contestedHtml = renderToStaticMarkup(React.createElement(LimitSealView, {
    record: record({
      status: "contested",
      statusLabel: "涨停有抛压",
      bids: [{ price: 8.43, volumeLots: 100000 }],
      asks: [{ price: 8.43, volumeLots: 100 }]
    }),
    lastTickAt: Date.now()
  }));
  assert.match(contestedHtml, /seal-book-ask[^>]*>.*?width:2%/, "tiny ask bar shares bid max scale (clamped to 2% min width)");
});

test("the seal panel shows amount, lots, ratio, change, peak, the live clock and the order book with the limit row marked", () => {
  const html = renderToStaticMarkup(React.createElement(LimitSealView, { record: record(), lastTickAt: Date.now() }));
  for (const text of ["实时涨停封单", "封死涨停", "6.54亿", "77.6万手 @ 8.43", "封单/流通市值", "7.32%", "1 分钟变化", "-1,200万", "今日峰值", "8.00亿", "回落 18%", "同花顺涨停池（封单）+ 腾讯实时五档 · 行情时间 10:37:09", "封单额走势"]) {
    assert.ok(html.includes(text), text);
  }
  assert.match(html, /seal-book-bid at-limit/);
  assert.match(html, /776,288/);
  const broken = renderToStaticMarkup(React.createElement(LimitSealView, { record: record({ status: "broken", statusLabel: "炸板", sealLots: null, sealAmount: null, sealFloatRatio: null, asks: [{ price: 8.2, volumeLots: 300 }] }), lastTickAt: 0 }));
  assert.match(broken, /炸板/);
  assert.match(broken, /已炸板：今天摸过涨停、现在打开/);
  assert.match(broken, /<strong>--<\/strong>/, "no seal is shown as --, never 0");
});
