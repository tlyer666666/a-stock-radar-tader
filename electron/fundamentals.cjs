"use strict";

/**
 * 基本面（业绩报表）：东方财富数据中心的业绩报表接口，每只股票取最近 8 期（季报/半年报/年报）。
 * 只给 AI 问股的 fundamentals 工具用：营收、归母净利润及同比、每股收益、ROE、毛利率、每股净资产、每股经营现金流。
 * 另算滚动四个季度的每股收益（TTM）= 最新一期累计 + 上年年报 − 上年同期累计，供调用方配合现价算滚动市盈率。
 * 报表是累计值（一季报 = 1–3 月，三季报 = 1–9 月）。取不到的数保持 null。6 小时缓存。
 */

const URL_BASE = "https://datacenter-web.eastmoney.com/api/data/v1/get";
const COLUMNS = "SECURITY_CODE,SECURITY_NAME_ABBR,REPORTDATE,DATATYPE,BASIC_EPS,TOTAL_OPERATE_INCOME,YSTZ,PARENT_NETPROFIT,SJLTZ,WEIGHTAVG_ROE,XSMLL,BPS,MGJYXJJE,NOTICE_DATE";
const CACHE_MS = 6 * 3600_000;

const num = value => { const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN; return Number.isFinite(n) ? n : null; };
const round = (value, digits = 2) => value === null ? null : Number(value.toFixed(digits));
const yi = value => value === null ? null : round(value / 1e8);

function normalizeReport(row) {
  const period = String(row?.REPORTDATE || "").slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(period)) return null;
  return {
    period, label: String(row?.DATATYPE || "").replace(/\s+/g, ""), noticeDate: String(row?.NOTICE_DATE || "").slice(0, 10),
    eps: round(num(row?.BASIC_EPS), 3), revenueYi: yi(num(row?.TOTAL_OPERATE_INCOME)), revenueYoyPct: round(num(row?.YSTZ)),
    netProfitYi: yi(num(row?.PARENT_NETPROFIT)), netProfitYoyPct: round(num(row?.SJLTZ)), roePct: round(num(row?.WEIGHTAVG_ROE)),
    grossMarginPct: round(num(row?.XSMLL)), bps: round(num(row?.BPS), 3), opCashPerShare: round(num(row?.MGJYXJJE), 3)
  };
}

/** 滚动四季每股收益：最新累计 + 上年年报 − 上年同期累计；最新一期就是年报时直接用年报。缺任一项返回 null。 */
function ttmEps(reports) {
  const latest = reports[0];
  if (!latest || latest.eps === null) return null;
  if (latest.period.endsWith("-12-31")) return latest.eps;
  const year = Number(latest.period.slice(0, 4));
  const annual = reports.find(item => item.period === `${year - 1}-12-31`);
  const same = reports.find(item => item.period === `${year - 1}${latest.period.slice(4)}`);
  if (!annual || !same || annual.eps === null || same.eps === null) return null;
  return round(latest.eps + annual.eps - same.eps, 3);
}

function createFundamentals({ fetchJson, now = () => Date.now() } = {}) {
  if (typeof fetchJson !== "function") throw new TypeError("fetchJson is required");
  const cache = new Map();
  async function load(code, { signal } = {}) {
    const key = String(code || "");
    if (!/^\d{6}$/.test(key)) throw new Error("请给出 6 位股票代码");
    const hit = cache.get(key);
    if (hit && hit.expiresAt > now()) return hit.value;
    const url = `${URL_BASE}?reportName=RPT_LICO_FN_CPD&columns=${COLUMNS}&filter=(SECURITY_CODE%3D%22${key}%22)&pageSize=8&pageNumber=1&sortColumns=REPORTDATE&sortTypes=-1`;
    const json = await fetchJson(url, { signal, headers: { Referer: "https://data.eastmoney.com/" } }, 8000);
    const rows = Array.isArray(json?.result?.data) ? json.result.data : [];
    const reports = rows.map(normalizeReport).filter(Boolean).sort((a, b) => b.period.localeCompare(a.period));
    const value = { code: key, name: String(rows[0]?.SECURITY_NAME_ABBR || ""), reports, ttmEps: ttmEps(reports), fetchedAt: new Date(now()).toISOString(), source: "东方财富业绩报表" };
    if (reports.length) cache.set(key, { value, expiresAt: now() + CACHE_MS });
    while (cache.size > 200) cache.delete(cache.keys().next().value);
    return value;
  }
  return { load };
}

module.exports = { createFundamentals, normalizeReport, ttmEps };
