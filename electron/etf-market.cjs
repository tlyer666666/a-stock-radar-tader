"use strict";

const EAST_LIST = "https://push2.eastmoney.com/api/qt/clist/get";
const FIELDS = "f2,f3,f5,f6,f7,f8,f10,f12,f13,f14,f17,f18,f20,f441";
const PAGE_SIZE = 100;
const CACHE_MS = 30_000;
const HIGH_PREMIUM_PERCENT = 3;
const THEME_MIN_AMOUNT = 1e8;

const GROUPS = [
  { bucket: "MK0021", label: "A股" },
  { bucket: "MK0022", label: "货币", category: "货币" },
  { bucket: "MK0023", label: "跨境", category: "跨境" },
  { bucket: "MK0024", label: "商品", category: "商品" },
  { bucket: "MK0827", label: "商品", category: "商品" },
  { bucket: "MK0828", label: "债券", category: "债券" }
];

const CATEGORY_ORDER = ["宽基", "行业主题", "跨境", "商品", "债券", "货币"];
const BROAD_INDEX = /沪深300|中证500|中证1000|中证2000|中证800|中证全指|上证50|上证180|上证380|上证指数|深证100|深证50|深证成指|科创50|科创100|科创200|科创综指|科创创业50|创业板50|创业板200|创业板指|创业板|双创|A500|A100|A50|中小100|国证2000|北证50|综指/g;
const STRATEGY = /红利|低波|现金流|增强|价值|成长|质量|动量|等权|ESG|央企|国企|民企/;
// 东财「A股」分组偶尔混入投资港股/海外的 ETF（如港股低波红利），按名称兜底归入跨境；
// 沪港深、A+H 等同时投 A 股和港股的跨市场 ETF 不属于跨境，仍按 A 股处理。
const CROSS_BORDER_NAME = /港股|恒生|香港|H股|中概|纳指|纳斯达克|标普|道琼斯|美国|日经|日本|东证|德国|法国|英国|欧洲|亚太|东南亚|沙特|巴西|越南|印度|新兴市场|全球|海外|中韩/;
const DOMESTIC_MIX_NAME = /沪港深|A\+H|AH|两岸|中华/;
// 交易所规定可当日回转（T+0）交易的 ETF：跨境、商品（黄金/商品期货）、债券、货币；A 股股票型 ETF 为 T+1。
const T0_CATEGORIES = new Set(["跨境", "商品", "债券", "货币"]);
const isT0Category = category => T0_CATEGORIES.has(category);

function num(value) {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() && value !== "-" ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
}

function premiumPercent(price, iopv) {
  const p = num(price), nav = num(iopv);
  if (p === null || nav === null || p <= 0 || nav <= 0) return null;
  return Math.round((p / nav - 1) * 10000) / 100;
}

function classifyEtf(bucket, name) {
  const group = GROUPS.find(item => item.bucket === bucket);
  if (group?.category) return group.category;
  const base = String(name || "").replace(/^XD/, "").split(/ETF|LOF/i)[0];
  if (CROSS_BORDER_NAME.test(base) && !DOMESTIC_MIX_NAME.test(base)) return "跨境";
  if (STRATEGY.test(base)) return "行业主题";
  const matched = base.match(BROAD_INDEX);
  const rest = base.replace(BROAD_INDEX, "").replace(/^(中证|国证|上证|深证)/, "").replace(/\d+|指数/g, "").trim();
  return matched && !rest ? "宽基" : "行业主题";
}

function normalizeRow(raw, bucket) {
  const code = String(raw?.f12 || "").trim();
  if (!/^\d{6}$/.test(code)) return null;
  const name = String(raw?.f14 || code).trim();
  const market = Number(raw?.f13) === 1 ? 1 : 0;
  const latest = num(raw?.f2), iopv = num(raw?.f441);
  const category = classifyEtf(bucket, name);
  return {
    code, name, secid: `${market}.${code}`, category, t0: isT0Category(category),
    latest, changePct: num(raw?.f3), amplitude: num(raw?.f7), volume: num(raw?.f5), amount: num(raw?.f6), turnover: num(raw?.f8), volumeRatio: num(raw?.f10),
    open: num(raw?.f17), preClose: num(raw?.f18), scale: num(raw?.f20), iopv, premiumPct: premiumPercent(latest, iopv)
  };
}

function summarize(items) {
  let rising = 0, falling = 0, flat = 0, totalAmount = 0, highPremium = 0;
  for (const item of items) {
    if (item.amount !== null) totalAmount += item.amount;
    if (item.premiumPct !== null && item.premiumPct > HIGH_PREMIUM_PERCENT) highPremium += 1;
    if (item.category === "货币" || item.changePct === null || item.latest === null) continue;
    if (item.changePct > 0) rising += 1;
    else if (item.changePct < 0) falling += 1;
    else flat += 1;
  }
  const byCategory = Object.fromEntries(CATEGORY_ORDER.map(category => [category, items.filter(item => item.category === category).length]));
  const t0Count = items.filter(item => item.t0).length;
  return { count: items.length, rising, falling, flat, totalAmount, highPremium, byCategory, t0Count };
}

function topThemes(items, limit = 5) {
  return items
    .filter(item => item.category === "行业主题" && item.changePct !== null && (item.amount ?? 0) >= THEME_MIN_AMOUNT)
    .sort((a, b) => b.changePct - a.changePct || (b.amount ?? 0) - (a.amount ?? 0))
    .slice(0, limit)
    .map(({ code, name, secid, changePct, amount }) => ({ code, name, secid, changePct, amount }));
}

function waitWithSignal(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(signal.reason || new DOMException("Aborted", "AbortError"));
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason || new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(
      value => { signal.removeEventListener("abort", onAbort); resolve(value); },
      error => { signal.removeEventListener("abort", onAbort); reject(error); }
    );
  });
}

function createEtfMarket({ fetchJson, now = () => Date.now(), concurrency = 3 } = {}) {
  if (typeof fetchJson !== "function") throw new TypeError("fetchJson is required");
  let cached = null;
  let pending = null;
  let generation = 0;

  const MAX_PAGES = 50;
  const pageUrl = (bucket, page) => `${EAST_LIST}?pn=${page}&pz=${PAGE_SIZE}&po=1&np=1&fltt=2&invt=2&fid=f6&fs=b:${bucket}&fields=${FIELDS}`;

  async function readGroup(group, signal) {
    const first = await fetchJson(pageUrl(group.bucket, 1), { signal }, 15000);
    const total = Math.max(0, Number(first?.data?.total) || 0);
    const rows = Array.isArray(first?.data?.diff) ? [...first.data.diff] : [];
    const pages = Math.min(MAX_PAGES, Math.ceil(total / PAGE_SIZE));
    for (let page = 2; page <= pages; page += 1) {
      signal?.throwIfAborted?.();
      const next = await fetchJson(pageUrl(group.bucket, page), { signal }, 15000);
      const diff = Array.isArray(next?.data?.diff) ? next.data.diff : [];
      if (!diff.length) break;
      rows.push(...diff);
    }
    return rows.map(raw => normalizeRow(raw, group.bucket)).filter(Boolean);
  }

  async function build(signal) {
    const results = new Array(GROUPS.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < GROUPS.length) {
        const index = cursor++;
        try { results[index] = { ok: true, items: await readGroup(GROUPS[index], signal) }; }
        catch (error) { signal?.throwIfAborted?.(); results[index] = { ok: false, error }; }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, GROUPS.length)) }, worker));
    const byCode = new Map();
    const warnings = [];
    results.forEach((result, index) => {
      if (!result.ok) { warnings.push(`${GROUPS[index].label} ETF 本轮没读到（${String(result.error?.message || result.error).slice(0, 40)}），稍后自动重试`); return; }
      for (const item of result.items) if (!byCode.has(item.code)) byCode.set(item.code, item);
    });
    const items = [...byCode.values()].sort((a, b) => (b.amount ?? -1) - (a.amount ?? -1));
    return { fetchedAt: new Date(now()).toISOString(), items, summary: summarize(items), topThemes: topThemes(items),
      highPremiumPercent: HIGH_PREMIUM_PERCENT, complete: warnings.length === 0, warnings: [...new Set(warnings)] };
  }

  return {
    async load({ forceRefresh = false, signal } = {}) {
      signal?.throwIfAborted?.();
      if (!forceRefresh && cached && cached.expiresAt > now()) return cached.value;
      if (!forceRefresh && pending) return waitWithSignal(pending, signal);
      const currentGen = ++generation;
      const flight = build().then(value => {
        if (currentGen === generation && value.items.length) cached = { value, expiresAt: now() + (value.complete ? CACHE_MS : 10_000) };
        return value;
      }).finally(() => {
        if (pending === flight) pending = null;
      });
      pending = flight;
      return waitWithSignal(flight, signal);
    }
  };
}

module.exports = { createEtfMarket, classifyEtf, premiumPercent, normalizeRow, isT0Category, CATEGORY_ORDER, HIGH_PREMIUM_PERCENT };
