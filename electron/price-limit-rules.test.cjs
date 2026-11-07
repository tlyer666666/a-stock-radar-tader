"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  isLimitUpBar,
  isOnePriceLimitUpEntry,
  priceLimitRate
} = require("./price-limit-rules.cjs");

test("price limit rates follow exchange board and effective-date rules", () => {
  assert.equal(priceLimitRate("600001", "ST样本", "2026-07-05"), 0.05);
  assert.equal(priceLimitRate("600001", "ST样本", "2026-07-06"), 0.1);
  assert.equal(priceLimitRate("300001", "ST样本", "2020-08-23"), 0.05);
  assert.equal(priceLimitRate("300001", "ST样本", "2020-08-24"), 0.2);
  assert.equal(priceLimitRate("300001", "普通样本", "2020-08-23"), 0.1);
  assert.equal(priceLimitRate("688001", "ST样本", "2026-07-06"), 0.2);
  assert.equal(priceLimitRate("920001", "ST样本", "2026-07-06"), 0.3);
});

test("historical point-in-time ST state takes precedence over the current name", () => {
  assert.equal(priceLimitRate("600001", "ST现名", "2026-07-06", false), 0.1);
  assert.equal(priceLimitRate("600001", "普通现名", "2026-07-05", true), 0.05);
});

test("entry-day limit rules determine whether a one-price entry is untradeable", () => {
  assert.equal(isOnePriceLimitUpEntry(10, {
    date: "2020-08-24", high: 11, low: 11
  }, "300001", "创业板样本"), false);
  assert.equal(isOnePriceLimitUpEntry(10, {
    date: "2020-08-24", high: 12, low: 12
  }, "300001", "创业板样本"), true);
  assert.equal(isOnePriceLimitUpEntry(10, {
    date: "2020-08-24", high: 11, low: 11, noPriceLimit: true
  }, "300001", "创业板样本"), false);
  assert.equal(isOnePriceLimitUpEntry(10, {
    date: "2026-07-06", high: 10.5, low: 10.5, isST: false
  }, "600001", "ST名称但入场日已摘帽"), false);
});

test("limit-up bars require the official upper limit rather than a one-cent tolerance", () => {
  assert.equal(isLimitUpBar(10, {
    date: "2026-07-06", high: 10.99, close: 10.99
  }, "600001"), false);
  assert.equal(isLimitUpBar(10, {
    date: "2026-07-06", high: 11, close: 11
  }, "600001"), true);
});

test("an official upper limit takes precedence and malformed official evidence fails closed", () => {
  assert.equal(isLimitUpBar(10, {
    date: "2026-07-06", high: 11.2, close: 11.2, upperLimit: 11.2
  }, "600001"), true);
  assert.equal(isLimitUpBar(10, {
    date: "2026-07-06", high: 11, close: 11, upperLimit: null
  }, "600001"), false);
  assert.equal(isLimitUpBar(0.91, {
    date: "2026-07-06", high: 1, close: 1, upperLimit: true
  }, "600001"), false);
  assert.equal(isLimitUpBar(10, {
    date: "2026-07-06", high: 11, close: 11, noPriceLimit: true
  }, "600001"), false);
});

test("one-price entry rejection requires the exact upper limit", () => {
  assert.equal(isOnePriceLimitUpEntry(10, {
    date: "2026-07-06", high: 10.99, low: 10.99
  }, "600001"), false);
  assert.equal(isOnePriceLimitUpEntry(10, {
    date: "2026-07-06", high: 11, low: 11
  }, "600001"), true);
});

test("BSE classification excludes B shares and delisted transfer codes", () => {
  const rules = require("./price-limit-rules.cjs");
  for (const code of ["900901", "400001", "420001", "990001"]) {
    assert.equal(rules.isBseAshareCode(code), false);
    assert.notEqual(priceLimitRate(code, "普通样本", "2026-10-19"), 0.3);
  }
  for (const code of ["430047", "830799", "872953", "880001", "920001"]) assert.equal(rules.isBseAshareCode(code), true);
});

test("opening purchase and closing sale guards use only the executable price", () => {
  const { isOpeningLimitUpEntry, isClosingLimitDownExit } = require("./price-limit-rules.cjs");
  assert.equal(isOpeningLimitUpEntry(10, { date: "2026-10-19", open: 11, low: 9, high: 11 }, "600001"), true);
  assert.equal(isOpeningLimitUpEntry(10, { date: "2026-10-19", open: 10.99, low: 10.99 }, "600001"), false);
  assert.equal(isClosingLimitDownExit(10, { date: "2026-10-19", close: 9, high: 11 }, "600001"), true);
  assert.equal(isClosingLimitDownExit(10, { date: "2026-10-19", close: 9.01, low: 9 }, "600001"), false);
  assert.equal(isClosingLimitDownExit(10, { date: "2026-10-19", close: 9, noPriceLimit: true }, "600001"), false);
});

test("explicit listing-day evidence bypasses generic price limits", () => {
  assert.equal(isLimitUpBar(10, { date: "2026-10-19", close: 11, high: 11 }, "600001", "N样本"), false);
  assert.equal(isLimitUpBar(10, { date: "2026-10-19", close: 12, high: 12 }, "300001", "C样本"), false);
});

test("official ex-right reference close takes precedence over yesterday raw close", () => {
  assert.equal(isLimitUpBar(20,{date:"2026-10-19",preClose:10,close:11,high:11},"600001"),true);
});

test("frontend and backend share the same main-board ST rate effective date", () => {
  // 防漂移：前端 paperTradingRules.ts 与后端 price-limit-rules.cjs 的 ST 生效日必须同源，
  // 避免两处各自演化后出现主板 ST 涨跌停口径不一致。
  const { MAIN_BOARD_ST_RATE_EFFECTIVE } = require("./price-limit-rules.cjs");
  const source = fs.readFileSync(
    path.join(__dirname, "..", "src", "features", "paper-simulation", "paperTradingRules.ts"),
    "utf8"
  );
  assert.ok(
    source.includes(`date < "${MAIN_BOARD_ST_RATE_EFFECTIVE}"`),
    "前端 paperTradingRules.ts 的 ST 生效日必须与 MAIN_BOARD_ST_RATE_EFFECTIVE 一致"
  );
});
