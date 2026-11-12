"use strict";

/**
 * 可转债行情 —— 全部来自同花顺免费接口。
 *
 *   新券名单（含正股）  https://data.10jqka.com.cn/ipo/kzz/           JSON，只含近一年多发行的约 80+ 只
 *   逐券实时快照        https://d.10jqka.com.cn/v6/realhead/{市场}_{代码}/last.js
 *                        市场号：19 = 上交所债券（110/111/113/118 开头），35 = 深交所债券（123/127/128 开头）
 *
 * 同花顺没有免费的「全部在市可转债」名单，所以名单分两步建立：
 *   1. 新券：直接取同花顺新券名单（带正股代码、上市/到期日）；
 *   2. 老券：按交易所可转债代码段逐个查询同花顺快照，近 20 天内仍有成交行情的才算在市（已到期、
 *      已强赎摘牌的代码不再有新行情，自然被排除）。结果存到本机，每 7 天重新核对一次。
 * 之后每次刷新只逐只读取在市债券的同花顺快照，渐进返回（与北交所页面一致）。
 */

const { fetchArrayBufferWithPolicy } = require("./http-client.cjs");
const { thsHeaders, unwrapJsonp, num } = require("./ths-quote.cjs");
const { getHexinToken } = require("./ths-hexin-v.cjs");

const FEED_URL = "https://data.10jqka.com.cn/ipo/kzz/";
const QUOTE_HOST = "https://d.10jqka.com.cn";
const ROSTER_SCHEMA = 1;
const DISCOVERY_TTL_MS = 7 * 24 * 3600 * 1000;
const ACTIVE_WITHIN_DAYS = 20;
/** 交易所可转债代码段（含少量余量；新券名单出现更大的代码时会自动向后扩展）。 */
const CODE_RANGES = Object.freeze([
  { from: 110000, to: 110099, market: 19 },
  { from: 111000, to: 111049, market: 19 },
  { from: 113000, to: 113729, market: 19 },
  { from: 118000, to: 118099, market: 19 },
  { from: 123000, to: 123309, market: 35 },
  { from: 127000, to: 127129, market: 35 },
  { from: 128000, to: 128149, market: 35 }
]);
const QUOTE_POLICY = Object.freeze({ timeoutMs: 4000, retries: 1, minimumGapMs: 60, queueTimeoutMs: 8000, maxResponseBytes: 256 * 1024 });
const PROBE_POLICY = Object.freeze({ timeoutMs: 4000, retries: 0, minimumGapMs: 80, queueTimeoutMs: 8000, maxResponseBytes: 256 * 1024 });

function bondMarket(code) {
  const value = String(code || "");
  if (/^11[0138]\d{3}$/.test(value)) return 19;
  if (/^12[378]\d{3}$/.test(value)) return 35;
  return null;
}

function isConvertibleCode(code) {
  return bondMarket(code) !== null;
}

function headers(referer) {
  const value = thsHeaders(referer);
  const token = getHexinToken();
  if (token) value.Cookie = `v=${token}`;
  return value;
}

function beijingDate(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

function parseBeijingTime(value) {
  const match = String(value || "").match(/(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] || "00"}+08:00`);
  return Number.isFinite(ms) ? ms : null;
}

const isoDate = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || "")) ? String(value) : "";

/** 同花顺新券名单 → 名单条目（只保留已上市、未到期的；未上市的单独返回供提示）。 */
function parseFeed(payload, today) {
  const list = Array.isArray(payload?.list) ? payload.list : [];
  const listed = [];
  const upcoming = [];
  for (const row of list) {
    const code = String(row?.bond_code || "");
    if (!isConvertibleCode(code)) continue;
    const entry = {
      code,
      name: String(row?.bond_name || code).trim(),
      market: Number(row?.market_id) === 19 || Number(row?.market_id) === 35 ? Number(row.market_id) : bondMarket(code),
      stockCode: /^\d{6}$/.test(String(row?.code || "")) ? String(row.code) : "",
      stockName: String(row?.name || "").trim(),
      listingDate: isoDate(row?.listing_date),
      expireDate: isoDate(row?.expire_date),
      source: "feed"
    };
    if (entry.expireDate && entry.expireDate < today) continue;
    if (entry.listingDate && entry.listingDate <= today) listed.push(entry);
    else upcoming.push(entry);
  }
  return { listed, upcoming };
}

/** realhead items → 债券快照；同时给出行情时间，用于判断是否仍在交易。 */
function normalizeBondQuote(code, payload) {
  const items = payload?.items;
  if (!items || String(items["5"] || "") !== code) throw new Error("同花顺可转债行情代码不匹配");
  const latest = num(items["10"]);
  if (!(latest > 0)) throw new Error("同花顺可转债行情无有效价格");
  const updatedMs = parseBeijingTime(items.updateTime);
  if (updatedMs === null) throw new Error("同花顺可转债行情缺少时间");
  const preClose = num(items["6"]);
  const volume = num(items["13"]);
  return {
    code,
    name: String(items.name || payload?.name || "").trim(),
    latest,
    preClose,
    open: num(items["7"]),
    high: num(items["8"]),
    low: num(items["9"]),
    changePct: num(items["199112"]) ?? (preClose > 0 ? (latest / preClose - 1) * 100 : null),
    change: num(items["264648"]),
    volume,            // 张
    amount: num(items["19"]),
    turnover: num(items["1968584"]),
    amplitude: num(items["526792"]),
    limitUp: num(items["69"]),
    limitDown: num(items["70"]),
    quoteAt: new Date(updatedMs).toISOString(),
    quoteDate: beijingDate(updatedMs)
  };
}

async function defaultReadQuote(market, code, signal, policy = QUOTE_POLICY) {
  const bytes = await fetchArrayBufferWithPolicy(`${QUOTE_HOST}/v6/realhead/${market}_${code}/last.js`,
    { headers: headers("https://stockpage.10jqka.com.cn/"), signal }, policy);
  return normalizeBondQuote(code, unwrapJsonp(new TextDecoder("utf-8").decode(bytes)));
}

async function defaultReadFeed(signal) {
  const bytes = await fetchArrayBufferWithPolicy(FEED_URL,
    { headers: { ...headers("https://data.10jqka.com.cn/ipo/bond/"), Accept: "application/json, text/plain, */*" }, signal },
    { timeoutMs: 8000, retries: 1, minimumGapMs: 200, maxResponseBytes: 4 * 1024 * 1024 });
  const json = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  if (Number(json?.status_code) !== 0) throw new Error(`同花顺新券名单返回错误：${json?.status_msg || json?.status_code}`);
  return json;
}

function remainingYears(expireDate, today) {
  if (!expireDate) return null;
  const days = (Date.parse(`${expireDate}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400000;
  return Number.isFinite(days) ? Number((days / 365).toFixed(2)) : null;
}

function createConvertibleSource({
  readFeed = defaultReadFeed,
  readQuote = defaultReadQuote,
  store = null,
  now = () => Date.now(),
  concurrency = 4,
  probeConcurrency = 3,
  timeoutMs = 240000
} = {}) {
  let cached = null;
  let pending = null;
  let pendingFirst = null;
  let progress = null;
  let roster = null; // { schema, discoveredAt, bonds: [{code,name,market,stockCode,stockName,listingDate,expireDate,source}] }

  function loadStoredRoster() {
    if (roster) return roster;
    try {
      const stored = store?.read?.();
      if (stored && stored.schema === ROSTER_SCHEMA && Array.isArray(stored.bonds)) {
        roster = { ...stored, bonds: stored.bonds.filter((bond) => isConvertibleCode(bond?.code)) };
      }
    } catch { /* 本机名单损坏时重新核对 */ }
    return roster;
  }

  function saveRoster(value) {
    roster = value;
    try { store?.write?.(value); } catch { /* 写盘失败不影响本次行情 */ }
  }

  function rangesFor(feedBonds) {
    return CODE_RANGES.map((range) => {
      const highest = feedBonds.filter((bond) => Number(bond.code) >= range.from && Number(bond.code) <= range.to + 200)
        .reduce((max, bond) => Math.max(max, Number(bond.code)), 0);
      return { ...range, to: Math.max(range.to, highest + 10) };
    });
  }

  /** 逐码核对老券：只把近 20 天内有行情的代码记为在市。 */
  async function discover(feedBonds, signal, report) {
    const known = new Set(feedBonds.map((bond) => bond.code));
    const candidates = [];
    for (const range of rangesFor(feedBonds)) {
      for (let code = range.from; code <= range.to; code += 1) {
        const text = String(code);
        if (!known.has(text)) candidates.push({ code: text, market: range.market });
      }
    }
    const today = beijingDate(now());
    const cutoff = beijingDate(now() - ACTIVE_WITHIN_DAYS * 86400000);
    const found = [];
    let cursor = 0;
    let checked = 0;
    let failures = 0;
    const worker = async () => {
      while (!signal.aborted && cursor < candidates.length) {
        const candidate = candidates[cursor++];
        try {
          const quote = await readQuote(candidate.market, candidate.code, signal, PROBE_POLICY);
          if (quote.quoteDate >= cutoff && quote.quoteDate <= today) {
            found.push({ code: candidate.code, name: quote.name || candidate.code, market: candidate.market, stockCode: "", stockName: "", listingDate: "", expireDate: "", source: "discovered" });
          }
        } catch (error) {
          // 「没有这个代码」（404，或返回里没有该券的价格）是核对的正常结果，不算失败；限流、超时、断网才算。
          const absent = Number(error?.status || 0) === 404 || /^同花顺可转债行情/.test(String(error?.message || ""));
          if (!absent) failures += 1;
        }
        checked += 1;
        if (checked % 50 === 0) report(checked, candidates.length, found.length);
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(probeConcurrency, 6)) }, worker));
    signal.throwIfAborted();
    // 全部失败多半是网络或限流，不是「没有可转债」：不覆盖旧名单。
    if (checked > 0 && failures >= checked) throw new Error("同花顺可转债代码核对全部失败，可能是网络或访问受限");
    // 失败过半时结果不可靠：不拿它覆盖旧名单，下次再核对。
    if (failures > checked / 2) throw new Error(`同花顺可转债代码核对有 ${failures}/${checked} 个请求失败，可能被限流`);
    return { found, checked, total: candidates.length };
  }

  function snapshot({ bonds, quotes, upcoming, discovery, warnings, pending: isPending }) {
    const today = beijingDate(now());
    const cutoff = beijingDate(now() - ACTIVE_WITHIN_DAYS * 86400000);
    const members = bonds.map((bond) => {
      const quote = quotes.get(bond.code);
      const status = !quote ? "unavailable" : quote.quoteDate < cutoff ? "inactive" : "ready";
      return {
        ...bond,
        name: bond.name || quote?.name || bond.code,
        latest: quote?.latest ?? null,
        preClose: quote?.preClose ?? null,
        changePct: quote?.changePct ?? null,
        amount: quote?.amount ?? null,
        volume: quote?.volume ?? null,
        turnover: quote?.turnover ?? null,
        amplitude: quote?.amplitude ?? null,
        high: quote?.high ?? null,
        low: quote?.low ?? null,
        quoteAt: quote?.quoteAt || "",
        quoteStatus: status,
        remainingYears: remainingYears(bond.expireDate, today),
        secid: `${bond.market === 19 ? 1 : 0}.${bond.code}`,
        thscode: `${bond.code}.${bond.market === 19 ? "SH" : "SZ"}`
      };
    }).filter((member) => member.quoteStatus !== "inactive");
    const ready = members.filter((member) => member.quoteStatus === "ready");
    const asOf = ready.map((member) => member.quoteAt.slice(0, 10)).sort().at(-1) || "";
    const rising = ready.filter((member) => member.changePct > 0).length;
    const falling = ready.filter((member) => member.changePct < 0).length;
    const changes = ready.map((member) => member.changePct).filter(Number.isFinite).sort((a, b) => a - b);
    const median = changes.length ? (changes.length % 2 ? changes[(changes.length - 1) / 2] : (changes[changes.length / 2 - 1] + changes[changes.length / 2]) / 2) : null;
    return {
      source: "同花顺可转债行情（新券名单 + 逐券快照）",
      fetchedAt: new Date(now()).toISOString(),
      asOf,
      members,
      upcoming,
      summary: {
        count: members.length,
        quoted: ready.length,
        rising,
        falling,
        flat: ready.length - rising - falling,
        medianChangePct: median === null ? null : Number(median.toFixed(2)),
        amount: ready.reduce((sum, member) => sum + (Number.isFinite(member.amount) ? member.amount : 0), 0)
      },
      quoteCoverage: { loaded: ready.length, total: members.length, pending: Boolean(isPending), complete: !isPending && ready.length === members.length },
      roster: { discoveredAt: discovery?.discoveredAt || null, feedCount: bonds.filter((bond) => bond.source === "feed").length,
        discoveredCount: bonds.filter((bond) => bond.source === "discovered").length, discovering: discovery?.discovering || null },
      warnings
    };
  }

  async function build(signal, publish) {
    const warnings = [];
    const today = beijingDate(now());
    let feed = { listed: [], upcoming: [] };
    try {
      feed = parseFeed(await readFeed(signal), today);
    } catch (error) {
      signal.throwIfAborted();
      warnings.push(`同花顺新券名单暂不可用：${String(error?.message || error).slice(0, 80)}`);
    }
    const stored = loadStoredRoster();
    let discovered = stored?.bonds?.filter((bond) => bond.source === "discovered") || [];
    let discoveredAt = stored?.discoveredAt || null;
    const quotes = new Map();
    const bondsNow = () => {
      const byCode = new Map(discovered.map((bond) => [bond.code, bond]));
      for (const bond of feed.listed) byCode.set(bond.code, { ...byCode.get(bond.code), ...bond });
      return [...byCode.values()].sort((a, b) => a.code.localeCompare(b.code));
    };
    const needsDiscovery = !discoveredAt || now() - Date.parse(discoveredAt) > DISCOVERY_TTL_MS;
    // 逐只读行情：已有行情的跳过；先用较高并发读一遍，再用 2 个并发补一遍失败的。
    const loadQuotes = async (bonds, discovery, note = "") => {
      const progress = () => publish(snapshot({ bonds, quotes, upcoming: feed.upcoming, discovery, pending: true,
        warnings: [...warnings, `正在逐只读取同花顺可转债行情：${quotes.size}/${bonds.length}${note}`] }));
      progress();
      let cursor = 0;
      let finished = 0;
      const worker = async () => {
        while (!signal.aborted && cursor < bonds.length) {
          const bond = bonds[cursor++];
          if (quotes.has(bond.code)) continue;
          try {
            quotes.set(bond.code, await readQuote(bond.market, bond.code, signal));
          } catch {
            signal.throwIfAborted();
          }
          finished += 1;
          if (finished % 20 === 0) progress();
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, 8, bonds.length || 1)) }, worker));
      cursor = 0;
      await Promise.all(Array.from({ length: Math.min(2, bonds.length || 1) }, worker));
      signal.throwIfAborted();
    };
    if (needsDiscovery) {
      // 先把手头名单（上次核对的 + 新券）的行情读出来，再去核对在市老券；核对要 2–3 分钟，不能让行情一直空着等它。
      if (bondsNow().length) await loadQuotes(bondsNow(), { discoveredAt }, discoveredAt ? "；随后重新核对在市名单（每 7 天一次）" : "；随后核对在市老券");
      const discovering = { checked: 0, total: 0, found: 0 };
      publish(snapshot({ bonds: bondsNow(), quotes, upcoming: feed.upcoming, discovery: { discoveredAt, discovering }, pending: true,
        warnings: [...warnings, discoveredAt ? "正在用同花顺重新核对在市可转债（每 7 天一次），先显示上次名单" : "首次使用：正在用同花顺逐个核对在市可转债代码，约需 2–3 分钟；新券已先显示"] }));
      try {
        const result = await discover(feed.listed, signal, (checked, total, found) => {
          Object.assign(discovering, { checked, total, found });
          publish(snapshot({ bonds: bondsNow(), quotes, upcoming: feed.upcoming, discovery: { discoveredAt, discovering }, pending: true, warnings }));
        });
        discovered = result.found;
        discoveredAt = new Date(now()).toISOString();
        saveRoster({ schema: ROSTER_SCHEMA, discoveredAt, bonds: bondsNow() });
      } catch (error) {
        signal.throwIfAborted();
        warnings.push(`在市可转债核对未完成（${String(error?.message || error).slice(0, 60)}），${discovered.length ? "沿用上次名单" : "暂只显示新券"}`);
      }
    } else if (feed.listed.length) {
      saveRoster({ schema: ROSTER_SCHEMA, discoveredAt, bonds: bondsNow() });
    }
    const bonds = bondsNow();
    await loadQuotes(bonds, { discoveredAt });
    signal.throwIfAborted();
    const missing = bonds.length - quotes.size;
    if (missing > 0) warnings.push(`${missing} 只可转债本轮未取到同花顺行情，仍保留在列表中`);
    if (!bonds.length) warnings.push("暂无可显示的可转债：同花顺名单与代码核对都没有结果");
    return snapshot({ bonds, quotes, upcoming: feed.upcoming, discovery: { discoveredAt }, pending: false, warnings });
  }

  return {
    async load({ forceRefresh = false, signal, waitForQuotes = true } = {}) {
      signal?.throwIfAborted();
      if (pending) {
        if (forceRefresh) {
          try { await pending; } catch { /* ignore previous error and continue */ }
          return this.load({ forceRefresh: false, signal, waitForQuotes });
        }
        return waitForQuotes ? pending : (progress || pendingFirst || pending);
      }
      if (!forceRefresh && cached && cached.expiresAt > now()) return cached.value;
      const bounded = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
      progress = null;
      let resolveFirst;
      const first = new Promise((resolve) => { resolveFirst = resolve; });
      const request = build(bounded, (value) => { progress = value; resolveFirst(value); }).then((value) => {
        cached = { value, expiresAt: now() + (value.quoteCoverage.complete ? 60000 : 20000) };
        progress = value;
        return value;
      });
      pending = request;
      pendingFirst = Promise.race([first, request]);
      pendingFirst.catch(() => {});
      request.then(() => { if (pending === request) pending = null; }, () => { if (pending === request) pending = null; });
      request.then(resolveFirst, () => {});
      return waitForQuotes ? request : pendingFirst;
    }
  };
}

module.exports = {
  CODE_RANGES,
  FEED_URL,
  ACTIVE_WITHIN_DAYS,
  bondMarket,
  isConvertibleCode,
  parseFeed,
  normalizeBondQuote,
  remainingYears,
  createConvertibleSource
};
