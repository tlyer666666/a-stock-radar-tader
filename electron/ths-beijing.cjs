"use strict";
const { fetchArrayBufferWithPolicy } = require("./http-client.cjs");
const { thsHeaders, unwrapJsonp, normalizeRealhead } = require("./ths-quote.cjs");
const { getHexinToken } = require("./ths-hexin-v.cjs");
const { isBseAshareCode, isLimitUpPrice, upperLimitPrice } = require("./price-limit-rules.cjs");
const { loadBeijingUniverse, normalizeListing, MAX_STOCKS } = require("./beijing-universe.cjs");
const bundledRoster = require("./beijing-roster.cjs");
const BEIJING_BOARD = Object.freeze({ code: "THS:BJ", name: "北交所", secid: "", type: "交易所", boardType: "exchange",
  displayCode: "北交所 · 逐股行情", sourceUrl: "https://stockpage.10jqka.com.cn/" });
function isBeijingSector(input) {
  if (input && typeof input === "object") return input.code === BEIJING_BOARD.code || isBeijingSector(input.name || input.query || "");
  return /^(北交所|北京证券交易所|京证A股|北证A股|THS:BJ|bj)$/i.test(String(input || "").trim());
}
function normalizeMembers(rows) {
  const seen = new Set();
  return rows.filter(row => isBseAshareCode(row.code) && !seen.has(row.code) && seen.add(row.code))
    .map(row => ({ ...row, secid: `0.${row.code}`, thscode: `${row.code}.BJ`, exchange: "BJ", assetType: "stock" }))
    .sort((a, b) => (b.changePct ?? -Infinity) - (a.changePct ?? -Infinity) || a.code.localeCompare(b.code));
}
function summarize(members, complete) {
  const changes = members.map(row => row.changePct).filter(Number.isFinite);
  const quoteComplete = complete && changes.length === members.length && members.length > 0;
  return { changePct: quoteComplete ? changes.reduce((sum, value) => sum + value, 0) / changes.length : null,
    quoteBasis: quoteComplete ? "北交所成分等权涨幅（逐股行情，非官方指数）" : "名单或行情未全部核验，整体涨幅显示 --",
    quotedCount: changes.length };
}
async function readThsQuote(code, signal) {
  const url = `https://d.10jqka.com.cn/v6/realhead/hs_${code}/last.js`;
  const headers = thsHeaders("https://stockpage.10jqka.com.cn/");
  const token = getHexinToken();
  if (token) headers.Cookie = `v=${token}`;
  const bytes = await fetchArrayBufferWithPolicy(url, { headers, signal }, {
    timeoutMs: 4000, retries: 2, minimumGapMs: 50, queueTimeoutMs: 5000, maxResponseBytes: 256 * 1024
  });
  const items = unwrapJsonp(new TextDecoder().decode(bytes))?.items;
  if (String(items?.["5"] || "") !== code) throw new Error("同花顺个股行情代码不匹配");
  const quote = normalizeRealhead(items);
  if (!(quote.latest > 0) || !Number.isFinite(quote.changePctResolved)) throw new Error("同花顺个股行情价格或涨幅缺失");
  const quoteAsOf = String(items.time || items.updateTime || "");
  if (!/^\d{4}-\d{2}-\d{2}/.test(quoteAsOf)) throw new Error("同花顺个股行情时间缺失");
  const turnover = Number(items["1968584"]);
  return { ...quote, code, changePct: quote.changePctResolved,
    turnover: items["1968584"] !== "" && Number.isFinite(turnover) && turnover >= 0 ? turnover : null,
    quoteAsOf, quoteSource: "同花顺", quoteStatus: "ready", limitStatusKnown: false };
}
function validateRoster(roster) {
  if (!Array.isArray(roster?.members) || !roster.members.length || roster.members.length > MAX_STOCKS) throw new Error("北交所名单无效");
  const members = roster.members.map(normalizeListing);
  if (new Set(members.map(row => row.code)).size !== members.length || roster.total !== members.length) throw new Error("北交所名单与声明总数不一致");
  return { ...roster, members };
}
function snapshotFor(roster, members, rosterError, isPending, now) {
    members = members.map(member => ({ ...member }));
    const days = members.filter(member => member.quoteStatus === "ready").map(member => member.quoteAsOf.slice(0, 10)).filter(Boolean);
    const asOf = days.sort().at(-1) || "";
    for (const member of members) if (member.quoteStatus === "ready" && member.quoteAsOf.slice(0, 10) !== asOf) member.quoteStatus = "stale";
    const quoted = members.filter(member => member.quoteStatus === "ready").length;
    const stale = members.filter(member => member.quoteStatus === "stale").length;
    const quoteComplete = quoted === members.length;
    const complete = roster.complete === true;
    const summary = summarize(members, complete && quoteComplete);
    const readySources = [...new Set(members.filter(member => member.quoteStatus === "ready").map(member => member.quoteSource || "同花顺"))]
      .sort((a, b) => (a === "腾讯行情" ? -1 : b === "腾讯行情" ? 1 : 0));
    const coverageSource = readySources.length ? readySources.join("、") : "";
    const warnings = [];
    if (!complete) warnings.push(`名单源本次未核验成功，保留 ${roster.fetchedAt?.slice(0, 10) || "上次"} 核验的 ${members.length} 只股票（最新总数待核验）：${rosterError}`);
    if (isPending) warnings.push(`正在读取行情：${quoted}/${members.length} 只；完整股票名单已显示，可直接搜索`);
    else if (!quoteComplete) warnings.push(`行情 ${quoted}/${members.length} 只${coverageSource ? `（${coverageSource}）` : ""}，${stale ? `${stale} 只行情日期较早，` : ""}${members.length - quoted - stale} 只暂缺行情；所有股票仍保留在列表中，整体涨幅显示 --`);
    return { ...BEIJING_BOARD, source: coverageSource ? `逐股行情（${coverageSource}）；新浪财经北交所股票名录` : "北交所行情读取中；新浪财经北交所股票名录", members: normalizeMembers(members),
      fetchedAt: new Date(now()).toISOString(), complete, memberCount: complete ? roster.total : null,
      memberCoverage: { loaded: members.length, total: complete ? roster.total : null, complete, source: roster.source,
        sourceUrl: roster.sourceUrl, verifiedAt: roster.fetchedAt, scope: complete ? "新浪财经北交所名录：前后总数一致，全部分页及空尾页已核验" : "上次核验的北交所名录，最新总数待核验" },
      quoteCoverage: { loaded: quoted, total: members.length, complete: quoteComplete, stale, source: coverageSource, asOf, pending: isPending },
      ...summary, warning: warnings.join("。") };
}

function beijingDateTime(iso) {
  const ms = Date.parse(String(iso || ""));
  if (!Number.isFinite(ms)) return "";
  return new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function createBeijingSectorSource({ readUniverse = loadBeijingUniverse, readQuote = readThsQuote, readBatch = null,
  fallbackRoster = bundledRoster, now = () => Date.now(), concurrency = 4, timeoutMs = 90000 } = {}) {
  let cached = null;
  let pending = null;
  let lastRoster = null;
  let progress = null;
  let ready;
  async function fetchSnapshot(signal, callerSignal, publish) {
    let roster;
    let rosterError = "";
    try {
      roster = validateRoster(await readUniverse({ signal, now }));
      if (roster.complete !== true) throw new Error("北交所名单总数尚未核验");
      lastRoster = roster;
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason || error;
      rosterError = String(error.message || error);
      const fallback = lastRoster || fallbackRoster;
      if (!fallback) throw error;
      roster = { ...validateRoster(fallback), complete: false };
    }
    const members = roster.members.map(member => ({ ...member, latest: null, changePct: null, amount: null,
      turnover: null, quoteStatus: "unavailable", quoteSource: "同花顺", limitStatusKnown: false }));
    publish(snapshotFor(roster, members, rosterError, true, now));
    if (readBatch) {
      try {
        const batchQuotes = await readBatch(members, signal);
        if (callerSignal?.aborted) throw callerSignal.reason;
        let applied = false;
        for (let index = 0; index < members.length; index += 1) {
          const member = members[index];
          if (member.quoteStatus === "ready") continue;
          const batchQuote = batchQuotes?.get?.(member.code);
          if (!batchQuote) continue;
          if (batchQuote.tradeStatus !== "trading" && batchQuote.tradeStatus !== "suspended") continue;
          if (!Number.isFinite(batchQuote.changePct)) continue;
          const limitPrice = upperLimitPrice(batchQuote.preClose, { preClose: batchQuote.preClose, name: member.name }, member.code, member.name);
          members[index] = { ...member, latest: batchQuote.latest, changePct: batchQuote.changePct,
            amount: batchQuote.amount ?? null, turnover: batchQuote.turnover ?? null,
            floatMarketCap: batchQuote.floatMarketCap ?? null, totalMarketCap: batchQuote.totalMarketCap ?? null,
            volume: batchQuote.volumeLots !== null ? batchQuote.volumeLots * 100 : null,
            preClose: batchQuote.preClose, open: batchQuote.open, high: batchQuote.high, low: batchQuote.low, change: batchQuote.change,
            quoteAsOf: beijingDateTime(batchQuote.quoteAt), quoteSource: "腾讯行情", quoteStatus: "ready",
            limitPrice, isLimitUp: limitPrice !== null && isLimitUpPrice(batchQuote.latest, limitPrice), limitStatusKnown: limitPrice !== null };
          applied = true;
        }
        if (applied) publish(snapshotFor(roster, members, rosterError, true, now));
      } catch (error) {
        if (callerSignal?.aborted) throw callerSignal.reason || error;
        if (signal.aborted) throw signal.reason ?? error;
      }
    }
    let cursor = 0;
    let finished = 0;
    const worker = async () => {
      while (!signal.aborted && cursor < members.length) {
        const index = cursor++;
        const identity = members[index];
        if (identity.quoteStatus === "ready") continue;
        try {
          const quote = await readQuote(identity.code, signal);
          if (quote.code !== identity.code || !(quote.latest > 0) || !Number.isFinite(quote.changePct) || !/^\d{4}-\d{2}-\d{2}/.test(quote.quoteAsOf || "")) throw new Error("同花顺行情身份或字段缺失");
          // 北交所涨跌幅 30%：同花顺快照带昨收，可以按涨停价判断；新股（N/C 开头）不设涨跌幅，判断不了。
          const limitPrice = upperLimitPrice(quote.preClose, { preClose: quote.preClose, name: identity.name }, identity.code, identity.name);
          members[index] = { ...identity, ...quote, ...identity, latest: quote.latest, changePct: quote.changePct,
            amount: quote.amount ?? null, turnover: quote.turnover ?? null, quoteAsOf: quote.quoteAsOf || "",
            quoteSource: "同花顺", quoteStatus: "ready", limitPrice,
            isLimitUp: limitPrice !== null && isLimitUpPrice(quote.latest, limitPrice), limitStatusKnown: limitPrice !== null };
        } catch (error) {
          if (callerSignal?.aborted) throw callerSignal.reason || error;
          // Keep the stock in the full roster even when its quote fails.
        }
        finished += 1;
        if (finished % 10 === 0) publish(snapshotFor(roster, members, rosterError, true, now));
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), 8, members.length) }, worker));
    // A second bounded pass retries only the failed stocks, retaining successful quotes.
    cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, members.length) }, worker));
    if (callerSignal?.aborted) throw callerSignal.reason;
    return snapshotFor(roster, members, rosterError, false, now);
  }
  let runController = null;
  let activeWaiters = new Set();

  function attachCallerSignal(promise, signal) {
    if (!signal) {
      const token = {};
      activeWaiters.add(token);
      return promise.finally(() => activeWaiters.delete(token));
    }
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
      const token = signal;
      activeWaiters.add(token);
      const cleanup = () => {
        activeWaiters.delete(token);
        signal.removeEventListener("abort", onAbort);
      };
      const onAbort = () => {
        cleanup();
        if (activeWaiters.size === 0 && runController) {
          runController.abort(signal.reason);
        }
        reject(signal.reason || new DOMException("Aborted", "AbortError"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (value) => { cleanup(); resolve(value); },
        (error) => { cleanup(); reject(error); }
      );
    });
  }

  return {
    async load({ forceRefresh = false, signal, waitForQuotes = true } = {}) {
      signal?.throwIfAborted();
      if (pending) {
        if (forceRefresh) {
          try { await attachCallerSignal(pending, signal); } catch { signal?.throwIfAborted(); }
          cached = null;
          return this.load({ forceRefresh: true, signal, waitForQuotes });
        }
        return attachCallerSignal(waitForQuotes ? pending : progress ? Promise.resolve(progress) : ready, signal);
      }
      if (!forceRefresh && cached && cached.expiresAt > now()) return cached.value;
      runController = new AbortController();
      activeWaiters = new Set();
      const boundedSignal = AbortSignal.any([runController.signal, AbortSignal.timeout(timeoutMs)]);
      progress = null;
      let resolveReady, rejectReady;
      ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
      ready.catch(() => {});
      const request = fetchSnapshot(boundedSignal, runController.signal, value => { progress = value; resolveReady(value); }).then(value => {
        cached = { value, expiresAt: now() + (value.complete && value.quoteCoverage.complete ? 60000 : 15000) };
        progress = value;
        return value;
      }, error => { rejectReady(error); throw error; });
      pending = request;
      request.then(
        () => { if (pending === request) { pending = null; runController = null; } },
        () => { if (pending === request) { pending = null; runController = null; } }
      );
      return attachCallerSignal(waitForQuotes ? request : progress ? Promise.resolve(progress) : ready, signal);
    }
  };
}
module.exports = { BEIJING_BOARD, isBeijingSector, normalizeMembers, summarize, readThsQuote, validateRoster, createBeijingSectorSource };
