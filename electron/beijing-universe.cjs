"use strict";
const { fetchJsonWithPolicy } = require("./http-client.cjs");
const { isBseAshareCode } = require("./price-limit-rules.cjs");
const SOURCE = "新浪财经北交所股票名录";
const BASE = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.";
const COUNT_URL = `${BASE}getHQNodeStockCount?node=hs_bjs`;
const PAGE_SIZE = 100;
const MAX_STOCKS = 1000;
const listingUrl = page => `${BASE}getHQNodeData?page=${page}&num=${PAGE_SIZE}&sort=symbol&asc=1&node=hs_bjs&symbol=&_s_r_a=page`;
async function defaultReadJson(url, signal) {
  return fetchJsonWithPolicy(url, { signal }, { timeoutMs: 6000, retries: 0, maxResponseBytes: 1024 * 1024,
    minimumGapMs: 150, headers: { Referer: "https://finance.sina.com.cn/", "User-Agent": "Mozilla/5.0" } });
}
function declaredCount(value) {
  if (!/^\d+$/.test(String(value))) throw new Error("北交所名录未返回有效总数");
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_STOCKS) throw new Error("北交所名录总数超出可核验范围");
  return count;
}
function normalizeListing(row) {
  const code = String(row?.code || "");
  const name = String(row?.name || "").trim();
  if (!isBseAshareCode(code) || row?.symbol !== `bj${code}` || !name || name.length > 80) throw new Error("北交所名录股票身份无效");
  // Quotes returned by this provider are deliberately excluded: displayed quotes come from THS.
  return { code, name, symbol: row.symbol, secid: `0.${code}`, thscode: `${code}.BJ`, exchange: "BJ", assetType: "stock" };
}
async function loadBeijingUniverse({ readJson = defaultReadJson, signal, now = () => Date.now() } = {}) {
  const total = declaredCount(await readJson(COUNT_URL, signal));
  const pages = Math.ceil(total / PAGE_SIZE);
  const members = [];
  const seen = new Set();
  let previous = "";
  for (let page = 1; page <= pages + 1; page += 1) {
    signal?.throwIfAborted();
    const raw = await readJson(listingUrl(page), signal);
    const expected = page > pages ? 0 : Math.min(PAGE_SIZE, total - members.length);
    if (!Array.isArray(raw) || raw.length !== expected) throw new Error(`北交所名录第 ${page} 页与声明总数不一致`);
    for (const entry of raw) {
      const member = normalizeListing(entry);
      if (seen.has(member.code) || member.symbol <= previous) throw new Error("北交所名录分页重复或排序漂移");
      seen.add(member.code);
      previous = member.symbol;
      members.push(member);
    }
  }
  const after = declaredCount(await readJson(COUNT_URL, signal));
  if (after !== total || members.length !== total) throw new Error("北交所名录总数在加载期间发生变化，请重试");
  return { members, total, complete: true, source: SOURCE, sourceUrl: COUNT_URL, fetchedAt: new Date(now()).toISOString(), pagesLoaded: pages };
}
module.exports = { loadBeijingUniverse, normalizeListing, declaredCount, SOURCE, COUNT_URL, listingUrl, MAX_STOCKS };
