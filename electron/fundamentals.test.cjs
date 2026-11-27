"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createFundamentals, ttmEps } = require("./fundamentals.cjs");
const { createStockAgentTools } = require("./stock-agent-tools.cjs");

const row = (date, label, eps, extra = {}) => ({ SECURITY_CODE: "600519", SECURITY_NAME_ABBR: "贵州茅台", REPORTDATE: `${date} 00:00:00`, DATATYPE: label, BASIC_EPS: eps, TOTAL_OPERATE_INCOME: 1.33e11, YSTZ: 1.82, PARENT_NETPROFIT: 6.45e10, SJLTZ: -0.25, WEIGHTAVG_ROE: 24.47, XSMLL: 89.58, BPS: 216.95, MGJYXJJE: 67.24, NOTICE_DATE: "2026-10-31 00:00:00", ...extra });
const rows = [row("2026-09-30", "2026年 三季报", 51.53), row("2026-06-30", "2026年 半年报", 35.57), row("2025-12-31", "2025年 年报", 65.66), row("2025-09-30", "2025年 三季报", 51.4, { BPS: null })];

test("reports are normalised to 亿 and percentages, missing numbers stay null, and TTM EPS rolls four quarters", async () => {
  const urls = [];
  const api = createFundamentals({ fetchJson: async url => { urls.push(url); return { result: { data: rows } }; }, now: () => 0 });
  const value = await api.load("600519");
  assert.match(urls[0], /RPT_LICO_FN_CPD/);
  assert.match(urls[0], /SECURITY_CODE%3D%22600519%22/);
  assert.equal(value.reports.length, 4);
  assert.deepEqual(value.reports[0], { period: "2026-09-30", label: "2026年三季报", noticeDate: "2026-10-31", eps: 51.53, revenueYi: 1330, revenueYoyPct: 1.82, netProfitYi: 645, netProfitYoyPct: -0.25, roePct: 24.47, grossMarginPct: 89.58, bps: 216.95, opCashPerShare: 67.24 });
  assert.equal(value.reports[3].bps, null);
  assert.equal(value.ttmEps, 65.79, "51.53 + 65.66 − 51.40");
  await api.load("600519");
  assert.equal(urls.length, 1, "cached for six hours");
  await assert.rejects(api.load("abc"), /6 位股票代码/);
  assert.equal(ttmEps([{ period: "2025-12-31", eps: 3 }]), 3, "an annual report is already four quarters");
  assert.equal(ttmEps([{ period: "2026-03-31", eps: 1 }]), null, "without last year's reports there is no TTM");
  const empty = createFundamentals({ fetchJson: async () => ({ result: null }) });
  assert.deepEqual((await empty.load("000001")).reports, []);
});

test("the fundamentals tool adds PE(TTM) and PB from the live price and refuses ETFs", async () => {
  const api = createFundamentals({ fetchJson: async () => ({ result: { data: rows } }) });
  const tools = createStockAgentTools({ fundamentals: code => api.load(code), quote: async security => ({ quote: { code: security.code, name: "贵州茅台", latest: 1466.5, quoteAt: new Date().toISOString() } }) });
  const result = await tools.runTool("fundamentals", { code: "600519" });
  assert.equal(result.ok, true);
  assert.equal(result.data.peTtm, 22.29);
  assert.equal(result.data.pb, 6.76);
  assert.match(result.summary, /净利润 645 亿（同比 -0.25%），ROE 24.47%/);
  const etf = await tools.runTool("fundamentals", { code: "510300" });
  assert.equal(etf.ok, false);
  assert.match(etf.summary, /ETF 没有业绩报表/);
  const noPrice = createStockAgentTools({ fundamentals: code => api.load(code), quote: async () => { throw new Error("offline"); } });
  const blind = await noPrice.runTool("fundamentals", { code: "600519" });
  assert.equal(blind.ok, true);
  assert.equal(blind.data.peTtm, null, "no live price → no PE, not a stale guess");
});
