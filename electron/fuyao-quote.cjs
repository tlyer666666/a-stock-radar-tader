"use strict";

/**
 * 同花顺扶摇实时报价（报价链首选；失败、限流或盘中陈旧时由同花顺免费行情接力）。
 *
 * - 合并请求：同一时刻（默认 30ms 内）各页面请求的股票合并成一次批量快照（每批最多 50 只），
 *   避免每只股票单独请求触发扶摇限流。
 * - 扶摇快照不含名称、换手率、市值、涨跌停价：名称取调用方证券信息；涨跌停价按交易所规则由昨收计算；
 *   换手率和市值用“股本档案”（同花顺免费行情的流通/总市值 ÷ 现价，6 小时缓存）计算，取不到就留空，不编造。
 * - 盘中（交易日 9:30–11:30、13:00–15:00）快照数据时间落后超过 3 分钟视为陈旧，交给下一路。
 */
const { upperLimitPrice, lowerLimitPrice } = require("./price-limit-rules.cjs");
const { tradingDateStatus } = require("./market-time-rules.cjs");

const PROFILE_TTL_MS = 6 * 60 * 60 * 1000;
const STALE_SECONDS = 180;

function finiteOrNull(value) {
  if (value === null || value === undefined || (typeof value === "string" && !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function quoteError(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function shanghaiParts(ms) {
  const text = new Date(ms + 8 * 3600 * 1000).toISOString();
  return { date: text.slice(0, 10), minutes: Number(text.slice(11, 13)) * 60 + Number(text.slice(14, 16)) };
}

/** 交易日连续竞价时段（含收盘前一刻）。日历未知的日期按工作日处理。 */
function inTradingSession(ms) {
  const { date, minutes } = shanghaiParts(ms);
  if (tradingDateStatus(date) === false) return false;
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  if (day === 0 || day === 6) return false;
  return (minutes >= 9 * 60 + 30 && minutes <= 11 * 60 + 30) || (minutes >= 13 * 60 && minutes <= 15 * 60);
}

/** 仅沪深A股走扶摇（北交所、可转债、ETF、指数仍走原链路）。 */
function fuyaoQuoteSupports(security) {
  const code = String(security?.code || "");
  return String(security?.assetType || "stock") === "stock" && /^(?:000|001|002|003|300|301|302|600|601|603|605|688|689)\d{3}$/.test(code);
}

function createFuyaoQuoteSource({ fuyao, loadProfile = null, now = () => Date.now(), batchWindowMs = 30, staleSeconds = STALE_SECONDS } = {}) {
  let pending = new Map();
  let timer = null;
  const profiles = new Map();

  async function profileFor(security) {
    if (typeof loadProfile !== "function") return null;
    const code = String(security.code);
    const hit = profiles.get(code);
    if (hit && now() - hit.at < PROFILE_TTL_MS) return hit.promise;
    const promise = Promise.resolve().then(() => loadProfile(security)).then(quote => {
      const latest = Number(quote?.latest);
      if (!(latest > 0)) return null;
      const floatCap = Number(quote?.floatMarketCap), totalCap = Number(quote?.totalMarketCap);
      return { name: String(quote?.name || ""), floatShares: floatCap > 0 ? floatCap / latest : null, totalShares: totalCap > 0 ? totalCap / latest : null };
    }).catch(() => null);
    profiles.set(code, { at: now(), promise });
    promise.then(value => { if (!value && profiles.get(code)?.promise === promise) profiles.delete(code); });
    if (profiles.size > 2000) profiles.delete(profiles.keys().next().value);
    return promise;
  }

  async function flush() {
    timer = null;
    const batch = pending;
    pending = new Map();
    const securities = [...batch.values()].map(entry => entry.security);
    try {
      const quotes = await fuyao.snapshot(securities);
      for (const [thscode, entry] of batch) {
        const snap = quotes.get(thscode);
        if (!snap) entry.waiters.forEach(waiter => waiter.reject(quoteError("同花顺扶摇快照没有该股票", "FUYAO_EMPTY")));
        else entry.waiters.forEach(waiter => waiter.resolve(snap));
      }
    } catch (error) {
      for (const entry of batch.values()) entry.waiters.forEach(waiter => waiter.reject(error));
    }
  }

  function snapshotFor(security, thscode) {
    return new Promise((resolve, reject) => {
      const entry = pending.get(thscode) || { security, waiters: [] };
      entry.waiters.push({ resolve, reject });
      pending.set(thscode, entry);
      if (!timer) timer = setTimeout(() => void flush(), batchWindowMs);
    });
  }

  async function quote(security) {
    if (!fuyaoQuoteSupports(security)) throw quoteError("扶摇报价只用于沪深A股", "FUYAO_UNSUPPORTED");
    const code = String(security.code);
    const thscode = `${code}.${/^6/.test(code) ? "SH" : "SZ"}`;
    const [snap, profile] = await Promise.all([
      snapshotFor(security, thscode),
      Promise.race([profileFor(security), new Promise(resolve => { const t = setTimeout(() => resolve(null), 2000); t.unref?.(); })])
    ]);
    const latest = Number(snap.latest);
    if (!(latest > 0)) throw quoteError("同花顺扶摇快照没有有效现价", "FUYAO_EMPTY");
    const quoteMs = Date.parse(snap.quoteAt || "");
    if (inTradingSession(now()) && (!Number.isFinite(quoteMs) || (now() - quoteMs) / 1000 > staleSeconds)) {
      throw quoteError(`同花顺扶摇行情盘中已 ${Number.isFinite(quoteMs) ? Math.round((now() - quoteMs) / 1000) : "--"} 秒未更新`, "FUYAO_STALE");
    }
    const name = String(security.name || profile?.name || code);
    const preClose = Number(snap.preClose) > 0 ? Number(snap.preClose) : null;
    const today = shanghaiParts(Number.isFinite(quoteMs) ? quoteMs : now()).date;
    const limitUp = preClose ? upperLimitPrice(preClose, { date: today }, code, name) : null;
    const limitDown = preClose ? lowerLimitPrice(preClose, { date: today }, code, name) : null;
    const volumeLots = finiteOrNull(snap.volume);
    const turnover = profile?.floatShares && volumeLots !== null ? (volumeLots * 100) / profile.floatShares * 100 : null;
    const changePct = finiteOrNull(snap.changePct) ?? (preClose ? (latest / preClose - 1) * 100 : null);
    const amount = finiteOrNull(snap.amount);
    const missingFields = [["latest", latest], ["changePct", changePct], ["turnover", turnover], ["volume", volumeLots], ["amount", amount]].filter(([, value]) => value === null || !Number.isFinite(value)).map(([key]) => key);
    return {
      code, name, secid: security.secid, thscode: security.thscode || thscode,
      assetType: "stock", assetLabel: security.marketName || "A股", pricePrecision: 2,
      latest, open: Number(snap.open) > 0 ? Number(snap.open) : null, high: Number(snap.high) > 0 ? Number(snap.high) : null,
      low: Number(snap.low) > 0 ? Number(snap.low) : null, preClose,
      volume: volumeLots, volumeUnit: "lots", amount, volumeRatio: null,
      limitUp, limitDown,
      // 股本未知时留空，不写 0（0 会被当成「0 元市值」）。
      totalMarketCap: profile?.totalShares ? profile.totalShares * latest : null,
      floatMarketCap: profile?.floatShares ? profile.floatShares * latest : null,
      industry: String(security.industry || ""),
      turnover, change: finiteOrNull(snap.change) ?? (preClose ? latest - preClose : null), changePct,
      amplitude: preClose && Number(snap.high) > 0 && Number(snap.low) > 0 ? (Number(snap.high) - Number(snap.low)) / preClose * 100 : null,
      quoteAt: Number.isFinite(quoteMs) ? new Date(quoteMs).toISOString() : new Date(now()).toISOString(),
      marketStatus: "", lagSeconds: Number.isFinite(quoteMs) && inTradingSession(now()) ? Math.max(0, Math.round((now() - quoteMs) / 1000)) : null,
      source: "fuyao", missingFields
    };
  }

  return { quote, supports: fuyaoQuoteSupports };
}

module.exports = { createFuyaoQuoteSource, fuyaoQuoteSupports, inTradingSession };
