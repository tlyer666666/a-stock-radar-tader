"use strict";
// R-01 / S-07 回归：格式化实现已收敛到 domain/formatters 的 createNumberFormatters。
//
// 收敛的前提是**输出逐字不变** —— 格式化直接决定用户看到的数字，任何一位小数、
// 空格、正负号的漂移都是可见回归。下面的期望值是收敛前用同一组输入实测捕获的原始输出，
// 并且逐项与收敛后的工厂输出做过 diff（完全一致）后才固化成断言。
//
// 三个模块的口径**刻意不同**，工厂把它们变成显式配置而不是复制代码：
//   · multiCompare        默认 2 位小数；金额 亿 2 位 / 万 0 位、无空格
//   · professionalReview  默认 1 位小数；金额 亿 1 位 / 万 1 位、无空格
//   · strategySignals     自带 nullableNumber（boolean/数组走 Number() 转换）；金额 亿 1 位 / 万 0 位
const test = require("node:test");
const assert = require("node:assert/strict");
const { registerTypeScript } = require("../../qa/register-typescript.cjs");
registerTypeScript();
const { createNumberFormatters, fmtAmount, fmtMoney, fmtPercent } = require("./formatters.ts");
const { nullableNumber } = require("../numericValue.ts");

// strategySignals 刻意保留的解析口径：对 "   " / true / [] 走 Number() 隐式转换。
const ownNullable = (value) => {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

// 覆盖：缺失（null/undefined/空串/空白串）、0 与 -0、正负小数、1e4 与 1e8 边界、
// 字符串数字、非数字字符串、boolean、数组、NaN、±Infinity。
const INPUTS = [null, undefined, "", "   ", 0, -0, 1, -1, 0.005, -0.005, 1.23456, -1.23456,
  1234, -1234, 9999, 10000, 12345, -12345, 1e6, 99999999, 1e8, -1.5e8, 1.234e8, 1e12,
  "12.5", "abc", true, false, [], [5], NaN, Infinity, -Infinity, 0.0001];

const CONFIGS = {
  multiCompare: createNumberFormatters(nullableNumber, { fmtDigits: 2, pctDigits: 2,
    money: { billionDigits: 2, tenThousandDigits: 0, unitSeparator: "", small: (v) => v.toFixed(0) } }),
  professionalReview: createNumberFormatters(nullableNumber, { fmtDigits: 1, pctDigits: 1,
    money: { billionDigits: 1, tenThousandDigits: 1, unitSeparator: "", small: (v) => v.toFixed(0) } }),
  strategySignals: createNumberFormatters(ownNullable, { fmtDigits: 1, pctDigits: 1,
    money: { billionDigits: 1, tenThousandDigits: 0, unitSeparator: "", small: (v) => v.toFixed(0) } })
};

test("multiCompare.number 输出与收敛前逐字一致", () => {
  const f = CONFIGS.multiCompare;
  const actual = INPUTS.map((v) => String(f.number(v)));
  assert.deepEqual(actual, ["0", "0", "0", "0", "0", "0", "1", "-1", "0.005", "-0.005", "1.23456", "-1.23456", "1234", "-1234", "9999", "10000", "12345", "-12345", "1000000", "99999999", "100000000", "-150000000", "123400000", "1000000000000", "12.5", "0", "0", "0", "0", "0", "0", "0", "0", "0.0001"]);
});

test("multiCompare.fmt 输出与收敛前逐字一致", () => {
  const f = CONFIGS.multiCompare;
  const actual = INPUTS.map((v) => String(f.fmt(v)));
  assert.deepEqual(actual, ["--", "--", "--", "--", "0.00", "0.00", "1.00", "-1.00", "0.01", "-0.01", "1.23", "-1.23", "1234.00", "-1234.00", "9999.00", "10000.00", "12345.00", "-12345.00", "1000000.00", "99999999.00", "100000000.00", "-150000000.00", "123400000.00", "1000000000000.00", "12.50", "--", "--", "--", "--", "--", "--", "--", "--", "0.00"]);
});

test("multiCompare.pct 输出与收敛前逐字一致", () => {
  const f = CONFIGS.multiCompare;
  const actual = INPUTS.map((v) => String(f.pct(v)));
  assert.deepEqual(actual, ["--", "--", "--", "--", "+0.00%", "+0.00%", "+1.00%", "-1.00%", "+0.01%", "-0.01%", "+1.23%", "-1.23%", "+1234.00%", "-1234.00%", "+9999.00%", "+10000.00%", "+12345.00%", "-12345.00%", "+1000000.00%", "+99999999.00%", "+100000000.00%", "-150000000.00%", "+123400000.00%", "+1000000000000.00%", "+12.50%", "--", "--", "--", "--", "--", "--", "--", "--", "+0.00%"]);
});

test("multiCompare.unit 输出与收敛前逐字一致", () => {
  const f = CONFIGS.multiCompare;
  const actual = INPUTS.map((v) => String(f.unit(v, 1, "%")));
  assert.deepEqual(actual, ["--", "--", "--", "--", "0.0%", "0.0%", "1.0%", "-1.0%", "0.0%", "-0.0%", "1.2%", "-1.2%", "1234.0%", "-1234.0%", "9999.0%", "10000.0%", "12345.0%", "-12345.0%", "1000000.0%", "99999999.0%", "100000000.0%", "-150000000.0%", "123400000.0%", "1000000000000.0%", "12.5%", "--", "--", "--", "--", "--", "--", "--", "--", "0.0%"]);
});

test("multiCompare.money 输出与收敛前逐字一致", () => {
  const f = CONFIGS.multiCompare;
  const actual = INPUTS.map((v) => String(f.money(v)));
  assert.deepEqual(actual, ["--", "--", "--", "--", "0", "0", "1", "-1", "0", "-0", "1", "-1", "1234", "-1234", "9999", "1万", "1万", "-1万", "100万", "10000万", "1.00亿", "-1.50亿", "1.23亿", "10000.00亿", "13", "--", "--", "--", "--", "--", "--", "--", "--", "0"]);
});

test("professionalReview.number 输出与收敛前逐字一致", () => {
  const f = CONFIGS.professionalReview;
  const actual = INPUTS.map((v) => String(f.number(v)));
  assert.deepEqual(actual, ["0", "0", "0", "0", "0", "0", "1", "-1", "0.005", "-0.005", "1.23456", "-1.23456", "1234", "-1234", "9999", "10000", "12345", "-12345", "1000000", "99999999", "100000000", "-150000000", "123400000", "1000000000000", "12.5", "0", "0", "0", "0", "0", "0", "0", "0", "0.0001"]);
});

test("professionalReview.fmt 输出与收敛前逐字一致", () => {
  const f = CONFIGS.professionalReview;
  const actual = INPUTS.map((v) => String(f.fmt(v)));
  assert.deepEqual(actual, ["--", "--", "--", "--", "0.0", "0.0", "1.0", "-1.0", "0.0", "-0.0", "1.2", "-1.2", "1234.0", "-1234.0", "9999.0", "10000.0", "12345.0", "-12345.0", "1000000.0", "99999999.0", "100000000.0", "-150000000.0", "123400000.0", "1000000000000.0", "12.5", "--", "--", "--", "--", "--", "--", "--", "--", "0.0"]);
});

test("professionalReview.pct 输出与收敛前逐字一致", () => {
  const f = CONFIGS.professionalReview;
  const actual = INPUTS.map((v) => String(f.pct(v)));
  assert.deepEqual(actual, ["--", "--", "--", "--", "+0.0%", "+0.0%", "+1.0%", "-1.0%", "+0.0%", "-0.0%", "+1.2%", "-1.2%", "+1234.0%", "-1234.0%", "+9999.0%", "+10000.0%", "+12345.0%", "-12345.0%", "+1000000.0%", "+99999999.0%", "+100000000.0%", "-150000000.0%", "+123400000.0%", "+1000000000000.0%", "+12.5%", "--", "--", "--", "--", "--", "--", "--", "--", "+0.0%"]);
});

test("professionalReview.unit 输出与收敛前逐字一致", () => {
  const f = CONFIGS.professionalReview;
  const actual = INPUTS.map((v) => String(f.unit(v, 1, "%")));
  assert.deepEqual(actual, ["--", "--", "--", "--", "0.0%", "0.0%", "1.0%", "-1.0%", "0.0%", "-0.0%", "1.2%", "-1.2%", "1234.0%", "-1234.0%", "9999.0%", "10000.0%", "12345.0%", "-12345.0%", "1000000.0%", "99999999.0%", "100000000.0%", "-150000000.0%", "123400000.0%", "1000000000000.0%", "12.5%", "--", "--", "--", "--", "--", "--", "--", "--", "0.0%"]);
});

test("professionalReview.money 输出与收敛前逐字一致", () => {
  const f = CONFIGS.professionalReview;
  const actual = INPUTS.map((v) => String(f.money(v)));
  assert.deepEqual(actual, ["--", "--", "--", "--", "0", "0", "1", "-1", "0", "-0", "1", "-1", "1234", "-1234", "9999", "1.0万", "1.2万", "-1.2万", "100.0万", "10000.0万", "1.0亿", "-1.5亿", "1.2亿", "10000.0亿", "13", "--", "--", "--", "--", "--", "--", "--", "--", "0"]);
});

test("strategySignals.number 输出与收敛前逐字一致", () => {
  const f = CONFIGS.strategySignals;
  const actual = INPUTS.map((v) => String(f.number(v)));
  assert.deepEqual(actual, ["0", "0", "0", "0", "0", "0", "1", "-1", "0.005", "-0.005", "1.23456", "-1.23456", "1234", "-1234", "9999", "10000", "12345", "-12345", "1000000", "99999999", "100000000", "-150000000", "123400000", "1000000000000", "12.5", "0", "1", "0", "0", "5", "0", "0", "0", "0.0001"]);
});

test("strategySignals.fmt 输出与收敛前逐字一致", () => {
  const f = CONFIGS.strategySignals;
  const actual = INPUTS.map((v) => String(f.fmt(v)));
  assert.deepEqual(actual, ["--", "--", "--", "0.0", "0.0", "0.0", "1.0", "-1.0", "0.0", "-0.0", "1.2", "-1.2", "1234.0", "-1234.0", "9999.0", "10000.0", "12345.0", "-12345.0", "1000000.0", "99999999.0", "100000000.0", "-150000000.0", "123400000.0", "1000000000000.0", "12.5", "--", "1.0", "0.0", "0.0", "5.0", "--", "--", "--", "0.0"]);
});

test("strategySignals.pct 输出与收敛前逐字一致", () => {
  const f = CONFIGS.strategySignals;
  const actual = INPUTS.map((v) => String(f.pct(v)));
  assert.deepEqual(actual, ["--", "--", "--", "+0.0%", "+0.0%", "+0.0%", "+1.0%", "-1.0%", "+0.0%", "-0.0%", "+1.2%", "-1.2%", "+1234.0%", "-1234.0%", "+9999.0%", "+10000.0%", "+12345.0%", "-12345.0%", "+1000000.0%", "+99999999.0%", "+100000000.0%", "-150000000.0%", "+123400000.0%", "+1000000000000.0%", "+12.5%", "--", "+1.0%", "+0.0%", "+0.0%", "+5.0%", "--", "--", "--", "+0.0%"]);
});

test("strategySignals.unit 输出与收敛前逐字一致", () => {
  const f = CONFIGS.strategySignals;
  const actual = INPUTS.map((v) => String(f.unit(v, 1, "%")));
  assert.deepEqual(actual, ["--", "--", "--", "0.0%", "0.0%", "0.0%", "1.0%", "-1.0%", "0.0%", "-0.0%", "1.2%", "-1.2%", "1234.0%", "-1234.0%", "9999.0%", "10000.0%", "12345.0%", "-12345.0%", "1000000.0%", "99999999.0%", "100000000.0%", "-150000000.0%", "123400000.0%", "1000000000000.0%", "12.5%", "--", "1.0%", "0.0%", "0.0%", "5.0%", "--", "--", "--", "0.0%"]);
});

test("strategySignals.money 输出与收敛前逐字一致", () => {
  const f = CONFIGS.strategySignals;
  const actual = INPUTS.map((v) => String(f.money(v)));
  assert.deepEqual(actual, ["--", "--", "--", "0", "0", "0", "1", "-1", "0", "-0", "1", "-1", "1234", "-1234", "9999", "1万", "1万", "-1万", "100万", "10000万", "1.0亿", "-1.5亿", "1.2亿", "10000.0亿", "13", "--", "1", "0", "0", "5", "--", "--", "--", "0"]);
});

// ── B-03：成交额只保留一套实现 ───────────────────────────────────────────────
// 修复前同一笔 1_200_000 元成交额有三种写法：fmtMoney「120.00 万」、
// MultiStockCompareView「120万」、PreviousLimitUpFailedBoards「0.01亿」。
test("fmtMoney / fmtAmount share one implementation with two decimals and 亿/万 units", () => {
  assert.equal(fmtAmount, fmtMoney, "fmtAmount 必须是 fmtMoney 的别名，而不能是第二份实现");
  assert.deepEqual(
    [0, 999, 9999, 12345, 1.2345e8, -12345, -1.2345e8, -999, 1e4, 1e8].map((value) => fmtMoney(value)),
    ["0", "999", "9,999", "1.23 万", "1.23 亿", "-1.23 万", "-1.23 亿", "-999", "1.00 万", "1.00 亿"]
  );
  for (const missing of [null, undefined, NaN, Infinity, -Infinity]) {
    assert.equal(fmtMoney(missing), "--", `missing ${String(missing)} must render --`);
  }
});

test("createNumberFormatters can delegate money to fmtMoney instead of cloning the conversion", () => {
  const compare = createNumberFormatters(nullableNumber, { money: fmtMoney });
  assert.equal(compare.money(1_200_000), "120.00 万");
  assert.equal(compare.money(null), "--");
  assert.equal(compare.money("abc"), "--");
});

// ── B-08：带符号百分比 ───────────────────────────────────────────────────────
test("fmtPercent keeps two decimals and an explicit sign", () => {
  assert.deepEqual(
    [2, -2.5, 0, 12.345, -0.004].map((value) => fmtPercent(value)),
    ["+2.00%", "-2.50%", "+0.00%", "+12.35%", "-0.00%"]
  );
  assert.equal(fmtPercent("3.456"), "+3.46%");
  for (const missing of [null, undefined, "", NaN, true]) {
    assert.equal(fmtPercent(missing), "--");
  }
});

test('missing market cap is unknown, and a positive secondary observation may fill it', () => {
  const {marketCapitalization} = require('./marketCapitalization.ts');
  for (const value of [undefined,null,'',0,'0',false,-1,Infinity]) assert.equal(marketCapitalization({totalMarketCap:value}),null);
  assert.equal(marketCapitalization({totalMarketCap:9000,missingFields:['totalMarketCap']}),null);
  assert.equal(marketCapitalization({totalMarketCap:0},'35000'),35000);
  assert.equal(marketCapitalization({totalMarketCap:8000}),8000);
});
