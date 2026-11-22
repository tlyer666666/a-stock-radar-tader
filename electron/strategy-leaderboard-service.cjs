"use strict";

/**
 * 策略实测榜的编排（主进程）：只读本机日线库，把全市场股票按批交给计算线程回放，再汇总成排行榜。
 *
 * 设计取舍：
 * - 不联网下载个股日线。数据就是「策略选股」已经建好的本机日线库；库是空的就直接告诉用户先去选一次股。
 * - 指数日线（用于确认下一交易日和算相对指数超额）读不到时照常统计，结果里标明。
 * - 分批：每批的日线读完交给计算线程，算完即释放，内存和单批耗时都有上限。
 * - 所有外部依赖都由调用方注入，便于离线单测。
 */

const { summarizeStrategyLeaderboard } = require("./strategy-leaderboard.cjs");

const LEADERBOARD_CHUNK_SIZE = 400;
const LEADERBOARD_READ_CONCURRENCY = 8;
const MIN_STOCKS = 200;

const idleProgress = () => ({ active: false, processed: 0, total: 0, startedAt: null, etaSeconds: null });

function createStrategyLeaderboardService({
  listCodes,
  readRows,
  loadNames = async () => new Map(),
  loadBenchmark = async () => [],
  runChunk,
  resolveSignalTo,
  isEligibleCode = code => /^\d{6}$/.test(code),
  isRiskName = () => false,
  assertActive = () => {},
  now = () => Date.now(),
  chunkSize = LEADERBOARD_CHUNK_SIZE,
  readConcurrency = LEADERBOARD_READ_CONCURRENCY,
  minStocks = MIN_STOCKS
} = {}) {
  for (const [name, fn] of Object.entries({ listCodes, readRows, runChunk, resolveSignalTo })) {
    if (typeof fn !== "function") throw new TypeError(`策略实测服务缺少 ${name}`);
  }
  let progress = idleProgress();
  let activeToken = null;

  async function readChunk(candidates) {
    const histories = {};
    const usable = [];
    let latest = "";
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(readConcurrency, candidates.length) }, async () => {
      while (cursor < candidates.length) {
        assertActive();
        const candidate = candidates[cursor++];
        let entry = null;
        try { entry = await readRows(candidate.code); }
        catch { entry = null; }
        const rows = Array.isArray(entry?.rows) ? entry.rows : null;
        if (!rows?.length) continue;
        histories[candidate.code] = rows;
        usable.push(candidate);
        const last = String(rows.at(-1)?.date || "");
        if (last > latest) latest = last;
      }
    }));
    // 并发读取会打乱顺序；按代码排序，保证同样的库得到同样的结果。
    usable.sort((left, right) => left.code.localeCompare(right.code));
    return { histories, usable, latest };
  }

  async function load(options = {}) {
    assertActive();
    const token = {};
    activeToken = token;
    const startedMs = now();
    const publish = (processed, total, active = true) => {
      if (activeToken !== token) return;
      const elapsed = Math.max(0.1, (now() - startedMs) / 1000);
      progress = {
        active, processed, total, startedAt: new Date(startedMs).toISOString(),
        etaSeconds: active && processed >= chunkSize && processed < total ? Math.max(1, Math.round((elapsed / processed) * (total - processed))) : active && processed >= total ? 0 : null
      };
    };
    try {
      const signalTo = String(resolveSignalTo() || "");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(signalTo)) throw new Error("无法确定最近的完整交易日，暂时不能做策略实测");
      const codes = [...new Set((await listCodes()).map(String))].filter(isEligibleCode).sort();
      assertActive();
      if (codes.length < minStocks) {
        throw Object.assign(new Error(`本机日线库只有 ${codes.length} 只股票，不够做全市场实测。请先到「策略选股」点一次「重新选股」，等全市场日线下载完再回来。`), { code: "LEADERBOARD_NO_LOCAL_BARS" });
      }
      let names = new Map();
      let namesAvailable = true;
      try { names = (await loadNames()) || new Map(); }
      catch { names = new Map(); }
      if (!(names instanceof Map) || !names.size) { names = new Map(); namesAvailable = false; }
      assertActive();
      let excludedRisk = 0;
      const candidates = [];
      for (const code of codes) {
        const name = String(names.get(code) || "");
        if (name && isRiskName(name)) { excludedRisk += 1; continue; }
        candidates.push({ code, name: name || code });
      }
      let benchmark = [];
      try { benchmark = await loadBenchmark(); }
      catch { benchmark = []; }
      if (!Array.isArray(benchmark)) benchmark = [];
      assertActive();

      publish(0, candidates.length);
      const chunks = [];
      let dataThrough = "";
      let readable = 0;
      for (let offset = 0; offset < candidates.length; offset += chunkSize) {
        assertActive();
        const { histories, usable, latest } = await readChunk(candidates.slice(offset, offset + chunkSize));
        if (latest > dataThrough) dataThrough = latest;
        readable += usable.length;
        if (usable.length) {
          const chunk = await runChunk(usable, histories, benchmark, { leaderboard: true, signalTo, ...(Array.isArray(options.strategyIds) ? { strategyIds: options.strategyIds } : {}) });
          assertActive();
          chunks.push(chunk);
        }
        publish(Math.min(candidates.length, offset + chunkSize), candidates.length);
      }
      const report = summarizeStrategyLeaderboard(chunks, { generatedAt: new Date(now()).toISOString() });
      if (!report || !report.stockCount) {
        throw Object.assign(new Error("本机日线库里没有足够长的日线可供回放，请先到「策略选股」重新选股以补齐日线。"), { code: "LEADERBOARD_NO_LOCAL_BARS" });
      }
      return {
        ...report,
        // 数据截至：本机日线库里最新的一根日线日期；晚于它的行情没有参与统计。
        dataThrough: dataThrough && dataThrough < signalTo ? dataThrough : signalTo,
        libraryStale: Boolean(dataThrough) && dataThrough < signalTo,
        universe: { localStocks: codes.length, readable, replayed: report.stockCount, excludedRisk, namesAvailable },
        elapsedSeconds: Math.round((now() - startedMs) / 1000)
      };
    } finally {
      if (activeToken === token) { progress = idleProgress(); activeToken = null; }
    }
  }

  return { load, getProgress: () => ({ ...progress }) };
}

module.exports = { createStrategyLeaderboardService, LEADERBOARD_CHUNK_SIZE };
