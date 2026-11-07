"use strict";

/**
 * 本地日线库（全市场选股用）：不复权日线按股票存在本机，避免每次选股都把全市场几千只股票的日线重新下载一遍。
 *
 * 取一只股票的日线时：
 *   1. 本地已有、且最新一根就是“最近完整交易日”（asOf）→ 直接用；
 *   2. 本地最新一根正好是 asOf 的上一个交易日，并且已为 asOf 准备好“收盘后批量快照”→ 用快照补一根；
 *      快照必须是 asOf 收盘后的数据、昨收与本地最后收盘一致（不一致说明除权，不能直接拼接）、当天有成交；
 *   3. 其他情况（首次、缺多天、除权、停牌后复牌、快照不可用）→ 完整重新下载并保存。
 * 历史暂未更新至 asOf 不能证明停牌：短暂复用后重试，避免上游恢复后仍整日缺尾。
 * 文件损坏或格式不对时当作没有缓存，重新下载；任何本地读写失败都不影响选股本身。
 *
 * 快照来源：东方财富全市场名单自带的收盘行情（quoteAtIsTradeTime=true，quoteAt 是最后成交时间）
 * 或同花顺扶摇批量快照（quoteAt 是接口返回时间）。两者都必须在“asOf 收盘后、下一交易日开盘前”取得。
 */
const fs = require("node:fs");
const path = require("node:path");
const { validateDailyBarRows } = require("./daily-bar-validation.cjs");

const STORE_VERSION = 1;
const MEMORY_ENTRIES = 64;
const STALE_RETRY_MS = 5 * 60 * 1000;
// 与日线来源返回的字段一致（含涨跌停价、ST、无涨跌幅限制等核验字段），保存后不丢信息。
const FIELDS = ["date", "open", "high", "low", "close", "volume", "amount", "preClose", "previousClose", "changePct", "change", "amplitude", "turnover",
  "upperLimit", "lowerLimit", "isST", "noPriceLimit", "adjustmentFactor", "adjFactor", "corporateActionUnresolved"];

function safeCode(code) {
  return /^\d{6}$/.test(String(code || "")) ? String(code) : null;
}

function encodeRows(rows) {
  return rows.map(row => FIELDS.map(key => (row[key] === undefined ? null : row[key])));
}

function decodeRows(rows) {
  return rows.map(values => Object.fromEntries(FIELDS.map((key, index) => [key, values[index]]).filter(([, value]) => value !== null)));
}

function storedRows(value) {
  if (!value || typeof value !== "object" || value.version !== STORE_VERSION || !Array.isArray(value.rows) ||
      !value.rows.every(row => Array.isArray(row) && row.length === FIELDS.length)) return null;
  try { return validateDailyBarRows(decodeRows(value.rows), { label: "本地日线" }); }
  catch { return null; }
}

/**
 * @param {object} options
 * @param {string|(() => string|null)} options.directory 存放目录（主进程注入 userData/daily-bars）；为空时只在内存里工作。
 * @param {(securities: object[]) => Promise<Map<string, object>>} [options.snapshot] 批量收盘快照（按 6 位代码返回）。
 * @param {(date: string) => string|null} options.previousSession 交易日历：asOf 的上一个交易日。
 * @param {number} [options.maxRows] 每只股票最多保留的日线根数。
 */
function shanghaiText(ms) {
  return new Date(ms + 8 * 3600 * 1000).toISOString();
}

/** 成交额 ÷ (成交量×100) 应落在当日价格区间附近：用来确认成交量单位是“手”，避免拼接不同单位的数据。 */
function lotsConsistent(row) {
  const volume = Number(row?.volume), amount = Number(row?.amount), high = Number(row?.high), low = Number(row?.low);
  if (!(volume > 0) || !(amount > 0) || !(high > 0) || !(low > 0)) return false;
  const vwap = amount / (volume * 100);
  return vwap >= low * 0.9 && vwap <= high * 1.1;
}

function createDailyBarStore({ directory = null, snapshot = null, previousSession, nextSession = null, maxRows = 420, now = () => Date.now() } = {}) {
  if (typeof previousSession !== "function") throw new TypeError("本地日线库需要交易日历");
  const memory = new Map();
  let writeSequence = 0;
  let prepared = { asOf: "", quotes: new Map() };
  const stats = { hits: 0, appended: 0, downloads: 0, writeFailures: 0 };

  const dir = () => (typeof directory === "function" ? directory() : directory) || null;
  const fileFor = code => { const base = dir(); return base ? path.join(base, `${code}.json`) : null; };

  // 主进程里运行：全部用异步文件读写，几千只股票也不会卡住界面；内存里只留最近用过的少量股票。
  const remember = (code, entry) => {
    memory.delete(code);
    memory.set(code, entry);
    if (memory.size > MEMORY_ENTRIES) memory.delete(memory.keys().next().value);
  };

  async function read(code) {
    if (memory.has(code)) return memory.get(code);
    const file = fileFor(code);
    if (!file) return null;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
      const rows = storedRows(parsed);
      if (!rows) return null;
      const entry = { rows, source: String(parsed.source || ""), checkedAsOf: String(parsed.checkedAsOf || ""),
        checkedAt: Number.isFinite(parsed.checkedAt) ? parsed.checkedAt : null, requested: Number(parsed.requested) || 0 };
      remember(code, entry);
      return entry;
    } catch {
      return null;
    }
  }

  /** 只读最后一根的日期（预取快照时判断用），不把整只股票的日线留在内存。 */
  async function lastDate(code) {
    if (memory.has(code)) return memory.get(code).rows.at(-1)?.date || null;
    const file = fileFor(code);
    if (!file) return null;
    try {
      const parsed = JSON.parse(await fs.promises.readFile(file, "utf8"));
      return storedRows(parsed)?.at(-1)?.date || null;
    } catch {
      return null;
    }
  }

  async function write(code, entry) {
    remember(code, entry);
    const file = fileFor(code);
    if (!file) return;
    const temp = `${file}.${process.pid}.${++writeSequence}.tmp`;
    try {
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(temp, JSON.stringify({ version: STORE_VERSION, source: entry.source, checkedAsOf: entry.checkedAsOf,
        checkedAt: entry.checkedAt ?? null, requested: entry.requested || 0, savedAt: new Date(now()).toISOString(), rows: encodeRows(entry.rows) }));
      await fs.promises.rename(temp, file);
    } catch {
      stats.writeFailures += 1;
      await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
  }

  /**
   * 为 asOf 预取收盘快照：只取“本地最新一根正好是上一交易日”的股票，扶摇批量接口一次 50 只。
   * 快照不可用时静默跳过，之后逐只完整下载。
   */
  async function prepareDay(securities, asOf) {
    // 同一交易日多次准备（趋势扫描、策略选股各一次）时合并，已取到的快照不丢。
    if (prepared.asOf !== asOf) prepared = { asOf, quotes: new Map() };
    if (typeof snapshot !== "function" || !asOf) return { requested: 0, received: 0 };
    const previous = previousSession(asOf);
    const wanted = [];
    const list = Array.isArray(securities) ? securities : [];
    for (let offset = 0; offset < list.length; offset += 32) {
      const batch = list.slice(offset, offset + 32);
      const dates = await Promise.all(batch.map(security => {
        const code = safeCode(security?.code);
        return code && !prepared.quotes.has(code) ? lastDate(code) : null;
      }));
      batch.forEach((security, index) => { if (dates[index] && dates[index] === previous) wanted.push(security); });
    }
    if (!wanted.length) return { requested: 0, received: 0 };
    let received = 0;
    try {
      const quotes = await snapshot(wanted);
      if (quotes instanceof Map) for (const [code, quote] of quotes) {
        if (safeCode(code) && quote) { prepared.quotes.set(code, quote); received += 1; }
      }
    } catch {
      // 快照不可用：之后逐只完整下载。
    }
    return { requested: wanted.length, received };
  }

  /** 快照是否确实是 asOf 收盘后的完整数据：在“asOf 15:05 至下一交易日 09:15”之间取得。 */
  function snapshotFinal(quote, asOf) {
    const from = Date.parse(`${asOf}T15:05:00+08:00`);
    const next = typeof nextSession === "function" ? nextSession(asOf) : null;
    const to = next ? Date.parse(`${next}T09:15:00+08:00`) : from + 18 * 3600 * 1000;
    const at = Date.parse(quote.quoteAt || "");
    const fetched = Number.isFinite(Number(quote.fetchedAt)) ? Number(quote.fetchedAt) : at;
    if (!Number.isFinite(at) || !(fetched >= from && fetched < to)) return false;
    if (quote.quoteAtIsTradeTime === true) {
      // 最后成交时间：必须是 asOf 当天收盘竞价之后（停牌股停在更早的日期，延迟行情停在盘中）。
      const text = shanghaiText(at);
      return text.slice(0, 10) === asOf && text.slice(11, 16) >= "15:00";
    }
    return at >= from && at < to;
  }

  /** 快照能否作为 asOf 这根完整日线：收盘后的数据、昨收接得上、当天有成交、价格自洽、成交量单位一致。 */
  function barFromSnapshot(quote, lastRow, asOf) {
    if (!quote || !lastRow || !snapshotFinal(quote, asOf)) return null;
    const [open, high, low, close, preClose] = [quote.open, quote.high, quote.low, quote.latest, quote.preClose].map(Number);
    if (![open, high, low, close, preClose].every(value => Number.isFinite(value) && value > 0)) return null;
    if (Math.abs(preClose / Number(lastRow.close) - 1) > 0.002) return null; // 除权或数据不连续
    if (high < Math.max(open, close) || low > Math.min(open, close)) return null;
    const volume = Number(quote.volume), amount = Number(quote.amount);
    if (!(volume > 0) || !(amount > 0)) return null; // 停牌
    const bar = { date: asOf, open, high, low, close, volume, amount, preClose,
      changePct: (close / preClose - 1) * 100, change: close - preClose, amplitude: (high - low) / preClose * 100 };
    if (!lotsConsistent(bar) || !lotsConsistent(lastRow)) return null;
    // 换手率：快照自带的直接用；没有时按上一根日线的“成交量 / 换手率”推出流通股本再换算（股本短期不变）。
    const ownTurnover = Number(quote.turnover);
    const lastTurnover = Number(lastRow.turnover), lastVolume = Number(lastRow.volume);
    if (Number.isFinite(ownTurnover) && ownTurnover >= 0) bar.turnover = ownTurnover;
    else if (lastTurnover > 0 && lastVolume > 0) bar.turnover = Math.round(volume / (lastVolume / (lastTurnover / 100)) * 100 * 1e4) / 1e4;
    return bar;
  }

  /**
   * 取一只股票截至 asOf 的不复权日线（形如 fetchFull 的返回值）。
   * fetchFull() 完整下载：返回 { rows, adjustment: "none", source, provenance }。
   */
  async function history(security, asOf, fetchFull, { bars = 0 } = {}) {
    const code = safeCode(security?.code);
    if (!code || !asOf) return fetchFull();
    let stored = await read(code);
    // 当初下载的根数少于这次需要的根数：重新完整下载（新股本来就短，下载时记录的是请求根数，不会反复下载）。
    if (stored && bars > 0 && (stored.requested || 0) < bars) stored = null;
    const lastDate = stored?.rows.at(-1)?.date;
    if (stored && lastDate === asOf) { stats.hits += 1; return result(stored, "local"); }
    if (stored && prepared.asOf === asOf && lastDate === previousSession(asOf)) {
      const bar = barFromSnapshot(prepared.quotes.get(code), stored.rows.at(-1), asOf);
      if (bar) {
        const entry = { rows: [...stored.rows, bar].slice(-maxRows), source: stored.source, checkedAsOf: asOf, requested: stored.requested };
        await write(code, entry);
        stats.appended += 1;
        return result(entry, "local+snapshot");
      }
    }
    // 旧 V1 文件只有 checkedAsOf，没有短期检查时间：不能把缺尾误当成整日已确认停牌。
    const checkedAge = stored && Number.isFinite(stored.checkedAt) ? now() - stored.checkedAt : Infinity;
    if (stored && stored.checkedAsOf === asOf && lastDate && lastDate < asOf && checkedAge >= 0 && checkedAge < STALE_RETRY_MS) {
      stats.hits += 1;
      return result(stored, "local");
    }
    const fresh = await fetchFull();
    stats.downloads += 1;
    // 只保存明确的不复权日线；应急源若给出其他口径，本次照常使用但不入库。
    // Validate the complete response before cutoff/maxRows filtering can hide
    // corrupt evidence. Empty histories remain uncached for new/suspended stocks.
    const allRows = fresh?.adjustment === "none" && fresh?.rows?.length !== 0
      ? validateDailyBarRows(fresh?.rows) : [];
    const rows = allRows.filter(row => row.date <= asOf);
    if (rows.length) await write(code, { rows: rows.slice(-maxRows).map(row => Object.fromEntries(FIELDS.filter(key => row[key] !== undefined && row[key] !== null).map(key => [key, row[key]]))),
      source: String(fresh.source || ""), checkedAsOf: asOf, checkedAt: now(), requested: Math.max(bars, rows.length) });
    // 下载与之后命中缓存返回同样的日期范围（都截到 asOf），结果不随缓存状态变化。
    return fresh?.adjustment === "none" && Array.isArray(fresh?.rows) ? { ...fresh, rows: fresh.rows.filter(row => String(row?.date || "") <= asOf) } : fresh;
  }

  function result(entry, cacheState) {
    return { rows: entry.rows.map(row => ({ ...row })), adjustment: "none", source: entry.source || "local-store",
      provenance: { source: entry.source || "local-store", amountUnit: "CNY", volumeUnit: "lot", cache: cacheState } };
  }

  return { prepareDay, history, stats: () => ({ ...stats }) };
}

module.exports = { createDailyBarStore, STORE_VERSION, lotsConsistent };
