"use strict";
// 从 electron/services.cjs 提取（2026-11-15 审核 P0-2b 拆分）。
// services.cjs 通过顶部解构回本模块并继续按原契约 re-export，勿在这里引入
// 对 services.cjs 的反向依赖。
const { SELECTION_HISTORY_BARS, createStrategySelectionService } = require("../strategy-selection-service.cjs");
const { roundTripBps } = require("../backtest-costs.cjs");
const { workerScriptPath } = require("../worker-runner.cjs");
const { DEFAULT_OPERATION_TIMEOUTS } = require("../job-lifecycle.cjs");
const { fuyaoQuoteSupports } = require("../fuyao-quote.cjs");
const { createDailyBarStore } = require("../daily-bar-store.cjs");
const { producerContext } = require("../service-context.cjs");
const _runtime = require("./runtime.cjs");
const { fuyao, stockIndustryIndex, serviceRuntime, workerRunner, strategySignalCache } = _runtime;
const jobSignalByStore = new WeakMap();
function serviceSignal(...args) {
  if (args.length > 0 && args[0] !== undefined) return _runtime.serviceSignal(...args);
  const store = producerContext.getStore();
  if (!store) return _runtime.serviceSignal();
  let cached = jobSignalByStore.get(store);
  if (!cached) {
    cached = _runtime.serviceSignal();
    jobSignalByStore.set(store, cached);
  }
  return cached;
}
function trackServiceRequest(...args) { return _runtime.trackServiceRequest(...args); }
function toSecurity(...args) { return _runtime.toSecurity(...args); }
const _backtest = require("./backtest.cjs");
const { dailyBarCalendar, trendThsLane } = _backtest;
function knownIndustry(...args) { return _backtest.knownIndustry(...args); }

// Only active loaders own generations; finally removes them without retaining query keys.
const strategySignalLoads = new Map();

const STRATEGY_SIGNAL_MAX_UNIVERSE = 300;

/** 同花顺池行业补齐：只查本机索引（不联网）；索引过期时在后台重建，不阻塞当前请求。 */
function industryFromIndex(code) {
  if (fuyao.configured()) void stockIndustryIndex.ensure().catch(() => null);
  return stockIndustryIndex.lookup(code) || knownIndustry({ code });
}

function strategySignalNumber(...values) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function strategySignalOptions(raw = {}) {
  const maxUniverse = Math.max(
    40,
    Math.min(
      STRATEGY_SIGNAL_MAX_UNIVERSE,
      Math.round(Number(raw.maxUniverse) || STRATEGY_SIGNAL_MAX_UNIVERSE)
    )
  );
  // 保留既有指标窗口；只计算当前规则，不运行历史收益回放。
  const historyBars = SELECTION_HISTORY_BARS;
  const maxStocksPerStrategy = Math.max(
    1,
    Math.min(200, Math.round(Number(raw.maxStocksPerStrategy) || 200))
  );
  const strategyIds = Array.isArray(raw.strategyIds)
    ? [...new Set(raw.strategyIds.map(String).filter(Boolean))].sort()
    : [];
  const rawCandidateLimit = Number(raw.candidateLimit);
  const candidateLimit =
    Number.isFinite(rawCandidateLimit) && rawCandidateLimit > 0
      ? Math.max(20, Math.min(6000, Math.trunc(rawCandidateLimit)))
      : undefined;
  return {
    provider: raw.provider === "eastmoney" ? "eastmoney" : "ths",
    fallbackEnabled: raw.fallbackEnabled !== false,
    multiSourceEnabled: raw.multiSourceEnabled !== false,
    maxUniverse,
    ...(candidateLimit !== undefined ? { candidateLimit } : {}),
    historyBars,
    maxStocksPerStrategy,
    strategyIds,
    // Saved user strategies and their optional watchlist universe come from the
    // main-process stores, never from the renderer; they are part of the cache key.
    customStrategies: Array.isArray(raw.customStrategies) ? raw.customStrategies : [],
    watchlistSecurities: Array.isArray(raw.watchlistSecurities)
      ? raw.watchlistSecurities.slice(0, 300).map(item => ({ code: String(item?.code || ""), name: String(item?.name || ""), secid: String(item?.secid || "") }))
      : [],
    replay: {
      horizonDays: raw.horizonDays,
      cooldownDays: raw.cooldownDays,
      minSamples: Math.max(
        120,
        Math.min(
          500,
          Math.round(strategySignalNumber(raw.minSamples) ?? 120)
        )
      ),
      minOutOfSampleSamples: Math.max(
        36,
        Math.min(
          200,
          Math.round(strategySignalNumber(raw.minOutOfSampleSamples) ?? 36)
        )
      ),
      minIndependentSignalDays: Math.max(
        60,
        Math.min(
          200,
          Math.round(strategySignalNumber(raw.minIndependentSignalDays) ?? 60)
        )
      ),
      minWalkForwardFoldSamples: Math.max(
        10,
        Math.min(
          20,
          Math.round(strategySignalNumber(raw.minWalkForwardFoldSamples) ?? 10)
        )
      ),
      minWinRate: Math.max(
        45,
        Math.min(100, strategySignalNumber(raw.minWinRate) ?? 45)
      ),
      minAverageReturn: Math.max(
        0.2,
        Math.min(20, strategySignalNumber(raw.minAverageReturn) ?? 0.2)
      ),
      maxDrawdown: Math.max(
        -22,
        Math.min(0, strategySignalNumber(raw.maxDrawdown) ?? -22)
      ),
      roundTripCostBps: Math.max(
        18,
        Math.min(200, strategySignalNumber(raw.roundTripCostBps) ?? roundTripBps())
      ),
      outOfSampleRatio: Math.max(
        0.3,
        Math.min(
          0.5,
          strategySignalNumber(raw.outOfSampleRatio) ?? 0.3
        )
      ),
      walkForwardFolds: Math.max(
        4,
        Math.min(
          5,
          Math.round(strategySignalNumber(raw.walkForwardFolds) ?? 4)
        )
      ),
      minCurrentHistoryBars: Math.max(
        120,
        Math.min(
          420,
          Math.round(strategySignalNumber(raw.minCurrentHistoryBars) ?? 120)
        )
      ),
      minReturnLowerBound: Math.max(
        0,
        Math.min(10, strategySignalNumber(raw.minReturnLowerBound) ?? 0)
      ),
      maxStrategyOverlap: Math.max(
        0.35,
        Math.min(0.72, strategySignalNumber(raw.maxStrategyOverlap) ?? 0.68)
      ),
      optimizedMinVotes: Math.max(
        2,
        Math.min(4, Math.round(strategySignalNumber(raw.optimizedMinVotes) ?? 2))
      ),
      terminalHoldoutRatio: Math.max(
        0.2,
        Math.min(0.35, strategySignalNumber(raw.terminalHoldoutRatio) ?? 0.2)
      )
    }
  };
}

function buildStrategySignalReportInWorker(candidates, historiesByCode, benchmarkRows, replay) {
  return serviceRuntime.track(() => workerRunner.run(workerScriptPath(__dirname, "../strategy-signal-worker.cjs"), {
    candidates, historiesByCode, benchmarkRows, replay
  }, {
    signal: serviceSignal(),
    // 全市场回放对应 job 的 scan 预算（600s），不能沿用 runner 的 120s 默认值
    timeoutMs: DEFAULT_OPERATION_TIMEOUTS.scan,
    timeoutMessage: "策略计算超时，请重新选股"
  }));
}

let dailyBarDirectory = null;

/** 收盘快照：优先用名单自带的东方财富收盘行情；没有的沪深股票再用扶摇批量快照（每批 50 只，限流即停）。 */
async function dailyBarSnapshots(securities) {
  const out = new Map(), missing = [];
  for (const security of Array.isArray(securities) ? securities : []) {
    const code = String(security?.code || "");
    if (security?.closeSnapshot && typeof security.closeSnapshot === "object") out.set(code, security.closeSnapshot);
    else missing.push(security);
  }
  const supported = missing.filter(security => fuyaoQuoteSupports(security));
  if (!supported.length || !fuyao.configured()) return out;
  for (let offset = 0; offset < supported.length; offset += 50) {
    const fetchedAt = Date.now();
    let quotes;
    try { quotes = await fuyao.snapshot(supported.slice(offset, offset + 50)); }
    catch (error) {
      if (/RATE_LIMITED|AUTH|NO_KEY/.test(String(error?.code || ""))) break;
      continue;
    }
    for (const quote of quotes.values()) if (/^\d{6}$/.test(String(quote?.code || ""))) out.set(String(quote.code), { ...quote, fetchedAt });
  }
  return out;
}

const dailyBarStore = createDailyBarStore({
  directory: () => (typeof dailyBarDirectory === "function" ? dailyBarDirectory() : dailyBarDirectory),
  snapshot: dailyBarSnapshots,
  previousSession: date => dailyBarCalendar.previousSession(date),
  nextSession: date => dailyBarCalendar.nextSession(date)
});
_runtime.bindShutdownResources?.({ dailyBarStore });

/** 本地日线库只在内置交易日历确认的“最近完整交易日”工作；日历过期时直接下载，不入库。 */
function dailyBarAsOf() {
  try {
    const expected = dailyBarCalendar.expectedCloseDate(new Date());
    return expected.state === "known" && expected.inferred !== true && expected.date ? expected.date : null;
  } catch { return null; }
}

function configureDailyBarStore({ directory } = {}) {
  dailyBarDirectory = typeof directory === "function" || (typeof directory === "string" && directory) ? directory : null;
}

const strategySelectionMarketData = require("../trend-screener-adapter.cjs").createTrendMarketData({ historyBars: SELECTION_HISTORY_BARS, ths: trendThsLane, dailyStore: dailyBarStore, asOf: dailyBarAsOf });

const SELECTION_UNIVERSE_BOARDS = Object.freeze([
  { label: "深市主板", filter: "m:0+t:6" }, { label: "沪市主板", filter: "m:1+t:2" }, { label: "创业板", filter: "m:0+t:80" },
  { label: "科创板", filter: "m:1+t:23" }, { label: "北交所", filter: "m:0+t:81+s:2048" }
]);

const SELECTION_UNIVERSE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function selectionUniverseCacheFile() {
  const directory = typeof dailyBarDirectory === "function" ? dailyBarDirectory() : dailyBarDirectory;
  return directory ? require("node:path").join(directory, "selection-universe.json") : null;
}

async function readSelectionUniverseCache() {
  try {
    const file = selectionUniverseCacheFile();
    if (!file) return null;
    const value = JSON.parse(await require("node:fs").promises.readFile(file, "utf8"));
    if (value?.v !== 1 || !Number.isFinite(value.savedAt) || Date.now() - value.savedAt > SELECTION_UNIVERSE_CACHE_MAX_AGE_MS || !value.boards) return null;
    return value;
  } catch { return null; }
}

let selectionUniverseWriteChain = Promise.resolve();

function writeSelectionUniverseCache(boards) {
  const file = selectionUniverseCacheFile();
  if (!file) return Promise.resolve(false);
  const path = require("node:path");
  const fsPromises = require("node:fs").promises;
  const keep = row => ({ code: row.code, name: row.name, secid: row.secid, industry: row.industry, assetType: row.assetType || "stock",
    ...(row.listingDate ? { listingDate: row.listingDate, listingDateSource: row.listingDateSource } : {}) });
  const payload = { v: 1, savedAt: Date.now(), savedDate: shanghaiDateText(), boards: Object.fromEntries(boards.map(board => [board.label, board.rows.map(keep)])) };
  const run = async () => {
    const pid = typeof process !== "undefined" ? process.pid : require("node:process").pid;
    const tempFile = path.join(path.dirname(file), `selection-universe.json.${pid}.${Date.now()}.tmp`);
    try {
      await fsPromises.mkdir(path.dirname(file), { recursive: true });
      await fsPromises.writeFile(tempFile, JSON.stringify(payload), { mode: 0o600 });
      await fsPromises.rename(tempFile, file);
      return true;
    } catch {
      /* 名单缓存只是兜底，写失败不影响本次选股；清理残留临时文件 */
      await fsPromises.rm(tempFile, { force: true }).catch(() => { /* ignore cleanup error */ });
      return false;
    }
  };
  selectionUniverseWriteChain = selectionUniverseWriteChain.then(run, run);
  return selectionUniverseWriteChain;
}

function selectionReportFile() {
  const directory = typeof dailyBarDirectory === "function" ? dailyBarDirectory() : dailyBarDirectory;
  return directory ? require("node:path").join(directory, "selection-report.json") : null;
}

async function readSavedSelectionReport(cacheKey) {
  try {
    const file = selectionReportFile();
    if (!file) return null;
    const saved = JSON.parse(await require("node:fs").promises.readFile(file, "utf8"));
    return saved?.v === 1 && saved.cacheKey === cacheKey && Number(saved.expiresAt) > Date.now() && saved.value ? saved : null;
  } catch { return null; }
}

let selectionReportWriteChain = Promise.resolve();

function writeSavedSelectionReport(cacheKey, expiresAt, value) {
  const file = selectionReportFile();
  if (!file) return Promise.resolve(false);
  const path = require("node:path");
  const fsPromises = require("node:fs").promises;
  const run = async () => {
    const tempFile = path.join(path.dirname(file), `selection-report.json.${process.pid}.${Date.now()}.tmp`);
    try {
      await fsPromises.mkdir(path.dirname(file), { recursive: true });
      await fsPromises.writeFile(tempFile, JSON.stringify({ v: 1, cacheKey, expiresAt, value }), { mode: 0o600 });
      await fsPromises.rename(tempFile, file);
      return true;
    } catch {
      await fsPromises.rm(tempFile, { force: true }).catch(() => { /* ignore cleanup error */ });
      return false;
    }
  };
  selectionReportWriteChain = selectionReportWriteChain.then(run, run);
  return selectionReportWriteChain;
}

function shanghaiDateText(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

/** 全市场A股名单（含北交所），每个板块逐页读完并核对总数；名单自带当日行情供本地日线库补最新一根。 */
async function loadSelectionUniverse() {
  const signal = serviceSignal();
  const pageSize = 100;
  // 某一页在东方财富失败后，后续页会改走新浪，两个来源的总数不同会让整板判为缺页；
  // 这时整板从第 1 页重读一次（本轮已认定东财不可用，会整板走同一来源）。
  const boards = await Promise.all(SELECTION_UNIVERSE_BOARDS.map(async board => {
    const first = await loadBoard(board);
    if (first.complete) return first;
    signal?.throwIfAborted();
    const second = await loadBoard(board);
    return second.complete || second.rows.length > first.rows.length ? second : first;
  }));
  async function loadBoard(board) {
    const rows = [];
    const seen = new Set();
    let expected = null;
    try {
      for (let page = 1; page <= 200; page += 1) {
        signal?.throwIfAborted();
        const response = await serviceRuntime.track(() => trackServiceRequest(strategySelectionMarketData.fetchUniversePage({ filter: board.filter, page, pageSize, signal })));
        const total = Number(response?.total);
        if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(response?.rows)) throw new Error(`第 ${page} 页缺少有效总数`);
        if (expected === null) expected = total;
        else if (total !== expected) throw new Error(`第 ${page} 页总数从 ${expected} 变为 ${total}`);
        if (rows.length + response.rows.length > expected) throw new Error(`第 ${page} 页超出名单总数 ${expected}`);
        for (const row of response.rows) {
          const code = String(row?.code || "");
          if (!/^\d{6}$/.test(code)) throw new Error(`第 ${page} 页含无效证券代码`);
          if (seen.has(code)) throw new Error(`第 ${page} 页含重复证券 ${code}`);
          seen.add(code); rows.push({ ...row, code });
        }
        if (rows.length === expected || !response.rows.length || response.rows.length < pageSize) break;
      }
      if (expected === null || seen.size !== expected) throw new Error(`名单缺页：${seen.size}/${expected ?? "?"}`);
      return { label: board.label, expected, loaded: rows.length, complete: true, rows };
    } catch (error) {
      signal?.throwIfAborted();
      return { label: board.label, expected, loaded: rows.length, complete: false, error: error instanceof Error ? error.message : String(error), rows };
    }
  }
  // 1.6.47：名单是慢变数据。东方财富和新浪都没读全的板块，用本机最近一次完整名单（7 天内）补上，
  // 不让一次限流就整页选不出股票；全部读全时更新本机名单。
  const cached = await readSelectionUniverseCache();
  for (const board of boards) {
    if (board.complete) continue;
    const saved = cached?.boards?.[board.label];
    if (!Array.isArray(saved) || !saved.length) continue;
    board.error = `${board.error || "名单缺页"}；已改用本机 ${cached.savedDate} 的完整名单（${saved.length} 只）`;
    board.rows = saved.map(row => ({ ...row }));
    board.loaded = saved.length;
    board.expected = saved.length;
    board.complete = true;
    board.fromCache = cached.savedDate;
  }
  const allFreshComplete = boards.every(board => board.complete && !board.fromCache);
  if (allFreshComplete) writeSelectionUniverseCache(boards);
  if (boards.every(board => !board.rows.length)) throw new Error(boards.map(board => `${board.label}：${board.error || "空名单"}`).join("；"));
  const rows = boards.flatMap(board => board.rows).map(row => {
    const industry = String(row?.industry || "").trim();
    return !industry || industry === "未分类" ? { ...row, industry: industryFromIndex(String(row?.code || "")) || "未分类" } : row;
  });
  if (allFreshComplete && typeof dailyBarStore !== "undefined" && typeof dailyBarStore?.cleanupStaleBars === "function") {
    void dailyBarStore.cleanupStaleBars({ activeCodes: rows.map(r => r.code) }).catch(() => {});
  }
  return { rows, boards: boards.map(({ rows: _rows, ...board }) => board) };
}

const strategySelectionLoader = createStrategySelectionService({
  loadUniverse: () => loadSelectionUniverse(),
  prepareHistories: securities => serviceRuntime.track(() => strategySelectionMarketData.prepareHistories(securities)),
  loadHistory: async security => {
    const signal = serviceSignal();
    if (security.assetType === "index") return serviceRuntime.track(() => trackServiceRequest(strategySelectionMarketData.fetchBenchmark({ signal })));
    const result = await serviceRuntime.track(() => trackServiceRequest(strategySelectionMarketData.fetchHistory(toSecurity(security), "none", { signal })));
    // The dedicated adapter rejects malformed/duplicate rows; it never drops
    // evidence to repair a window or estimates amount from close * volume.
    Object.defineProperty(result.rows, "dataSource", { value: result.source || "unknown", configurable: true });
    return result.rows;
  },
  runEngine: buildStrategySignalReportInWorker,
  getDiagnostics: () => strategySelectionMarketData.getDiagnostics?.({ signal: serviceSignal() }) || {},
  assertActive: () => serviceSignal()?.throwIfAborted()
});

function loadStrategySignals(options, runtime = {}) {
  return strategySelectionLoader.load(options, runtime);
}

function scanStrategySignals(rawOptions = {}, runtime = {}) {
  const options = strategySignalOptions(rawOptions);
  // Past the bundled calendar the loader infers sessions from the index; key by hour then.
  let selectionContext;
  try { selectionContext = strategySelectionLoader.context(); }
  catch { selectionContext = { asOfDate: `inferred:${new Date().toISOString().slice(0, 13)}` }; }
  const { replay: _unusedReplay, ...selectionCacheOptions } = options;
  const cacheKey = JSON.stringify([selectionCacheOptions, selectionContext.asOfDate]);
  const forceRefresh = rawOptions?.refresh === true;
  const identity = JSON.stringify([cacheKey, forceRefresh]);
  return serviceRuntime.run("selection", identity, runtime, async () => {
    const cached = strategySignalCache.get(cacheKey);
    if (!forceRefresh && cached?.value && cached.expiresAt > Date.now()) return cached.value;
    if (!forceRefresh) {
      const saved = await readSavedSelectionReport(cacheKey);
      if (saved) {
        strategySignalCache.set(cacheKey, { value: saved.value, expiresAt: Number(saved.expiresAt) });
        return saved.value;
      }
    }
    const generation = {};
    strategySignalLoads.set(cacheKey, generation);
    try {
      const value = await loadStrategySignals(options, { forceRefresh });
      serviceRuntime.checkpoint();
      // A newer load may already have published and removed its generation.
      // Absence is not permission for an older producer to replace that result.
      if (strategySignalLoads.get(cacheKey) === generation) {
        // A clean result for a completed session cannot change until the next
        // session closes; degraded results (failed/stale reads) retry after 5 min.
        const validUntil = Number(value?.cacheValidUntil);
        const clean = Number.isFinite(validUntil) && validUntil > Date.now();
        const expiresAt = clean ? validUntil : Date.now() + 5 * 60 * 1000;
        strategySignalCache.set(cacheKey, { value, expiresAt });
        if (clean) await writeSavedSelectionReport(cacheKey, expiresAt, value);
      }
      return value;
    } finally {
      if (strategySignalLoads.get(cacheKey) === generation) strategySignalLoads.delete(cacheKey);
    }
  });
}

module.exports = {
  strategySignalLoads,
  STRATEGY_SIGNAL_MAX_UNIVERSE,
  industryFromIndex,
  strategySignalNumber,
  strategySignalOptions,
  buildStrategySignalReportInWorker,
  dailyBarDirectory,
  dailyBarSnapshots,
  dailyBarStore,
  dailyBarAsOf,
  configureDailyBarStore,
  strategySelectionMarketData,
  SELECTION_UNIVERSE_BOARDS,
  SELECTION_UNIVERSE_CACHE_MAX_AGE_MS,
  selectionUniverseCacheFile,
  readSelectionUniverseCache,
  writeSelectionUniverseCache,
  shanghaiDateText,
  loadSelectionUniverse,
  strategySelectionLoader,
  loadStrategySignals,
  scanStrategySignals
};
