"use strict";

const { createHash } = require("node:crypto");
const { performance: clock } = require("node:perf_hooks");

const BOARDS = Object.freeze([
  { id: "mainSZ", label: "深市主板", filter: "m:0+t:6" },
  { id: "mainSH", label: "沪市主板", filter: "m:1+t:2" },
  { id: "growth", label: "创业板", filter: "m:0+t:80" },
  { id: "star", label: "科创板", filter: "m:1+t:23" },
  { id: "beijing", label: "北交所", filter: "m:0+t:81+s:2048" }
]);
const PAGE_SIZE = 100;
const MIN_STOCK_BARS = 250;
const MIN_BENCHMARK_BARS = 80;
const MAX_CACHE_ENTRIES = 10000;
const CACHE_TTL_MS = 15 * 60 * 1000;
const MAX_HISTORY_CONCURRENCY = 6;
const PIPELINE_VERSION = "trend-scan-3.1.0";
const TREND_LIBRARY = require("../config/trend-strategy-library.json");
const MAX_STRATEGIES = TREND_LIBRARY.length + 2;

const FUNNEL_STAGES = ["rawValidated", "recentLimitPassed", "trendPassed", "technicalTriggered", "riskPassed"];
const TECHNICAL_LABELS = Object.fromEntries(TREND_LIBRARY.map(item => [item.id, item.technicalLabels]));
function emptyDiagnostics() {
  return { sources: [], funnel: { universeEligible: 0, ...Object.fromEntries(FUNNEL_STAGES.map(key => [key, 0])) }, reasons: [] };
}
function technicalTriggered(candidate) {
  if (candidate.stage === "signal") return true;
  const labels = TECHNICAL_LABELS[candidate.strategy?.id];
  if (!labels) return Array.isArray(candidate.patterns) && candidate.patterns.length > 0;
  return labels.every(label => candidate.evidence?.some(row => row.label === label && row.passed === true));
}

function emptyPerformance() {
  return { rawRequests: 0, adjustedRequests: 0, cacheHits: 0,
    prefilterExcluded: 0, elapsedMs: 0, peakHistoryConcurrency: 0 };
}

function shanghaiClock(value) {
  const date = value instanceof Date ? value : new Date(value);
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(date).filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minute: Number(parts.hour) * 60 + Number(parts.minute)
  };
}

function priorDate(date) {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() - 1);
  return value.toISOString().slice(0, 10);
}

function validAStock(code) {
  return /^(?:00[0-3]|30[012]|60[0135]|68[89])\d{3}$/.test(code) ||
    /^(?:[48]\d{5}|920\d{3})$/.test(code);
}

function riskName(name) {
  const text = String(name || "").replace(/\s+/g, "").toUpperCase();
  return text.includes("ST") || text.includes("退");
}

function normalizeSecurity(row) {
  const code = String(row?.code ?? row?.f12 ?? "").trim();
  const name = String(row?.name ?? row?.f14 ?? "").trim();
  if (!validAStock(code) || riskName(name) || row?.isST === true || row?.st === true) {
    return null;
  }
  const exchange = /^(?:60[0135]|68[89])/.test(code) ? "SH" : /^[489]/.test(code) ? "BJ" : "SZ";
  return {
    code, name, secid: `${exchange === "SH" ? 1 : 0}.${code}`,
    thscode: `${code}.${exchange}`, assetType: "stock",
    industry: String(row?.industry ?? row?.f100 ?? "未分类")
  };
}

function knownSuspended(row) {
  return row?.suspended === true || row?.isSuspended === true || row?.tradingStatus === "suspended";
}

function isoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const epoch = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(epoch) && new Date(epoch).toISOString().slice(0, 10) === value;
}

function validBars(input, cutoff, priceOnly = false) {
  const source = Array.isArray(input) ? input : input?.rows;
  if (!Array.isArray(source)) return [];
  const seen = new Set();
  const rows = [];
  for (const row of source) {
    const date = row?.date;
    if (!isoDate(date)) throw new Error(`日线日期无效：${String(date || "缺失")}`);
    if (date > cutoff) continue;
    if (seen.has(date)) throw new Error(`日线日期重复：${date}`);
    if ([row?.open, row?.high, row?.low, row?.close, ...(priceOnly ? [] : [row?.volume, row?.amount])]
      .some((value) => value === null || value === undefined || value === "")) throw new Error(`日线字段缺失：${date}`);
    const open = Number(row.open), high = Number(row.high), low = Number(row.low);
    const close = Number(row.close);
    const volume = priceOnly && row.volume == null ? null : Number(row.volume);
    const amount = priceOnly && row.amount == null ? null : Number(row.amount);
    if (![open, high, low, close].every(Number.isFinite) ||
        open <= 0 || high < Math.max(open, close) || low > Math.min(open, close) ||
        low <= 0 || [volume, amount].some(value => priceOnly && value === null ? false : !Number.isFinite(value) || (priceOnly ? value < 0 : value <= 0))) throw new Error(`日线价格或成交无效：${date}`);
    seen.add(date);
    rows.push({ ...row, date, open, high, low, close, volume, amount });
  }
  return rows.sort((left, right) => left.date.localeCompare(right.date));
}

function clone(value) { return structuredClone(value); }
function errorMessage(error) { return error instanceof Error ? error.message : String(error); }
function strategySetHash(snapshots) {
  return createHash("sha256").update(JSON.stringify(snapshots)).digest("hex");
}
function strategyStatus(snapshots, hash) {
  return {
    strategies: snapshots, strategySetHash: hash,
    ...(snapshots.length === 1 ? { strategy: snapshots[0] } : {}),
    strategyStats: snapshots.map(strategy => ({ strategy, processed: 0, candidateCount: 0,
      excluded: 0, unavailable: 0, failed: 0, coverageComplete: false }))
  };
}

function createTrendScreenerService(deps) {
  if (![deps?.fetchUniversePage, deps?.fetchHistory, deps?.fetchBenchmark].every((fn) => typeof fn === "function")) {
    throw new TypeError("趋势扫描需要证券名单、日线与基准行情适配器");
  }
  const now = typeof deps.now === "function" ? deps.now : () => new Date();
  const engine = () => require("./trend-screener-engine.cjs");
  const strategies = () => require("./trend-strategy.cjs");
  const rank = deps.rankCandidates || ((rows, options) => strategies().rankTrendStrategyCandidates(rows, options));
  // Injected evaluators may have different necessary conditions. Production uses
  // the shared engine prefilter, while an injected evaluator opts in explicitly.
  const prefilter = deps.prefilterStock || (deps.evaluateStock || deps.evaluateBatch ? null : (input) => engine().prefilterTrendStock(input));
  let generation = 0;
  let active = null;
  let cacheBasis = "";
  const cache = new Map();
  // Slots belong to the service, not a job. Cancelling cannot release a slot
  // until its physical request settles, even if an adapter ignores AbortSignal.
  let historyInFlight = 0;
  const historyWaiters = [];
  const initialStrategies = [strategies().normalizeTrendStrategy()];
  let status = {
    jobId: "", phase: "idle", startedAt: "", updatedAt: "", asOf: "",
    universeLoaded: 0, universeExpected: null, processed: 0, excluded: 0,
    unavailable: 0, failed: 0, coverageComplete: false, marketGate: "unknown",
    boards: BOARDS.map(({ id, label }) => ({ id, label, expected: null, loaded: 0, complete: false })),
    candidates: [], errors: [], note: "尚未扫描。公开行情规则推算，待核验；策略收益未经验证。",
    validation: "unvalidated", ...strategyStatus(initialStrategies, strategySetHash(initialStrategies)), performance: emptyPerformance(), diagnostics: emptyDiagnostics()
  };
  const stamp = () => new Date(now()).toISOString();
  const current = (token) => active === token && !token.cancelled;
  const elapsed = (token) => Math.max(0, Math.round(clock.now() - token.startedClock));
  const refreshSources = token => {
    if (active !== token || typeof deps.getDiagnostics !== "function") return;
    const sources = deps.getDiagnostics({ signal: token.controller.signal })?.sources;
    if (Array.isArray(sources)) status.diagnostics.sources = clone(sources);
  };
  const publish = (token) => {
    if (current(token)) {
      refreshSources(token);
      status.updatedAt = stamp();
      status.performance.elapsedMs = elapsed(token);
    }
  };
  const snapshot = () => {
    if (active && current(active)) refreshSources(active);
    const value = clone(status);
    if (active && current(active)) value.performance.elapsedMs = elapsed(active);
    return value;
  };
  const fail = (token, stage, message, code) => {
    if (!current(token)) return;
    status.errors.push({ ...(code ? { code } : {}), stage, message });
    status.updatedAt = stamp();
  };

  function drainHistoryQueue() {
    while (historyInFlight < MAX_HISTORY_CONCURRENCY && historyWaiters.length) {
      const waiter = historyWaiters.shift();
      waiter.token.controller.signal.removeEventListener("abort", waiter.abort);
      if (waiter.token.controller.signal.aborted) {
        waiter.reject(waiter.token.controller.signal.reason);
        continue;
      }
      historyInFlight += 1;
      waiter.resolve();
    }
  }

  async function withHistorySlot(token, operation) {
    const signal = token.controller.signal;
    signal.throwIfAborted();
    await new Promise((resolve, reject) => {
      const waiter = { token, resolve, reject, abort: null };
      waiter.abort = () => {
        const index = historyWaiters.indexOf(waiter);
        if (index >= 0) historyWaiters.splice(index, 1);
        signal.removeEventListener("abort", waiter.abort);
        reject(signal.reason);
      };
      historyWaiters.push(waiter);
      signal.addEventListener("abort", waiter.abort, { once: true });
      drainHistoryQueue();
    });
    try {
      signal.throwIfAborted();
      if (!current(token)) return null;
      status.performance.peakHistoryConcurrency = Math.max(status.performance.peakHistoryConcurrency, historyInFlight);
      return await operation();
    } finally {
      historyInFlight -= 1;
      drainHistoryQueue();
    }
  }

  function fetchStockHistory(token, security, adjustment) {
    return withHistorySlot(token, () => {
      status.performance[adjustment === "none" ? "rawRequests" : "adjustedRequests"] += 1;
      return deps.fetchHistory(security, adjustment, { signal: token.controller.signal });
    });
  }

  function normalizeOptions(options) {
    if (!options || typeof options !== "object" || Array.isArray(options) ||
        ![Object.prototype, null].includes(Object.getPrototypeOf(options)) ||
        Reflect.ownKeys(options).some(key => !["strategyId", "config", "strategies", "forceRefresh"].includes(key))) {
      throw new TypeError("扫描参数仅允许 strategyId、config、strategies 和 forceRefresh");
    }
    if (options.forceRefresh !== undefined && typeof options.forceRefresh !== "boolean") {
      throw new TypeError("强制刷新参数 forceRefresh 必须为布尔值");
    }
    let selections;
    if (Object.hasOwn(options, "strategies")) {
      if (Object.hasOwn(options, "strategyId") || Object.hasOwn(options, "config")) {
        throw new TypeError("多策略参数 strategies 不能与单策略 strategyId/config 混用");
      }
      if (!Array.isArray(options.strategies) || options.strategies.length < 1 || options.strategies.length > MAX_STRATEGIES) {
        throw new TypeError(`策略列表必须包含 1 至 ${MAX_STRATEGIES} 个策略配置`);
      }
      selections = Array.from(options.strategies, option => {
        if (!option || typeof option !== "object" || Array.isArray(option) || !Object.hasOwn(option, "strategyId") ||
            typeof option.strategyId !== "string" || Reflect.ownKeys(option).some(key => !["strategyId", "config"].includes(key))) {
          throw new TypeError("策略列表每项必须提供 strategyId 参数");
        }
        return strategies().normalizeTrendStrategy(option);
      });
      if (new Set(selections.map(strategy => strategy.id)).size !== selections.length) {
        throw new TypeError("策略列表不能重复选择相同策略");
      }
    } else {
      selections = [strategies().normalizeTrendStrategy({
        ...(options.strategyId !== undefined ? { strategyId: options.strategyId } : {}),
        ...(options.config !== undefined ? { config: options.config } : {})
      })];
    }
    selections.sort((left, right) => left.id.localeCompare(right.id));
    return { strategies: selections, strategySetHash: strategySetHash(selections), forceRefresh: options.forceRefresh === true };
  }

  async function loadUniverse(token) {
    const unique = new Map();
    const loadedCodes = new Set();
    let expectedSum = 0;
    for (let boardIndex = 0; boardIndex < BOARDS.length; boardIndex += 1) {
      if (!current(token)) return null;
      const definition = BOARDS[boardIndex];
      const board = status.boards[boardIndex];
      let total = null;
      let received = 0;
      const seenOnBoard = new Set();
      try {
        for (let page = 1; current(token); page += 1) {
          const response = await deps.fetchUniversePage({ filter: definition.filter, page, pageSize: PAGE_SIZE, signal: token.controller.signal });
          if (!current(token)) return null;
          const reported = Number(response?.total);
          if (response?.total === null || response?.total === undefined ||
              !Number.isSafeInteger(reported) || reported < 0 || !Array.isArray(response?.rows)) {
            throw new Error(`第 ${page} 页缺少有效 total/rows`);
          }
          if (total === null) {
            total = reported;
            board.expected = total;
            expectedSum += total;
            status.universeExpected = expectedSum;
          } else if (reported !== total) {
            throw new Error(`第 ${page} 页总数从 ${total} 变为 ${reported}`);
          }
          const rows = response.rows;
          if (total === 0) {
            if (rows.length) throw new Error("总数为零却返回证券");
            break;
          }
          if (!rows.length) throw new Error(`第 ${page} 页为空，已取 ${received}/${total}`);
          for (const row of rows) {
            const code = String(row?.code ?? row?.f12 ?? "").trim();
            if (!code || seenOnBoard.has(code)) throw new Error(`第 ${page} 页重复或缺少证券代码 ${code}`);
            seenOnBoard.add(code);
            received += 1;
            if (!loadedCodes.has(code)) {
              loadedCodes.add(code);
              const name = String(row?.name ?? row?.f14 ?? "").trim();
              if (!name) {
                applyOutcomes(token, { code }, sharedOutcomes(token, {
                  kind: "unavailable", reason: "证券名称缺失，无法排除 ST/退市风险"
                }), "universe");
              } else if (knownSuspended(row) && validAStock(code) &&
                         !riskName(name) && row?.isST !== true && row?.st !== true) {
                applyOutcomes(token, { code }, sharedOutcomes(token, {
                  kind: "unavailable", reason: "证券已标记停牌，未纳入趋势评估"
                }), "universe");
              } else {
                const security = normalizeSecurity(row);
                if (security) {
                  unique.set(security.code, security);
                  status.diagnostics.funnel.universeEligible = unique.size;
                }
                else applyOutcomes(token, { code }, sharedOutcomes(token, { kind: "excluded" }), "universe");
              }
            }
          }
          board.loaded = received;
          status.universeLoaded = loadedCodes.size;
          publish(token);
          if (received >= total) break;
          if (rows.length < PAGE_SIZE) throw new Error(`第 ${page} 页不足 ${PAGE_SIZE} 条，已取 ${received}/${total}`);
        }
        if (received !== total) throw new Error(`板块名单缺页：${received}/${total}`);
        board.complete = true;
      } catch (error) {
        if (!current(token)) return null;
        board.loaded = received;
        board.error = errorMessage(error);
        if (error?.code === "MARKET_DATA_SOURCE_UNAVAILABLE") throw error;
        status.failed += 1;
        status.strategyStats.forEach(item => { item.failed += 1; });
        fail(token, "universe", `${board.label}：${board.error}`);
      }
    }
    status.universeExpected = status.boards.every((board) => board.expected !== null)
      ? expectedSum : null;
    status.universeLoaded = loadedCodes.size;
    return [...unique.values()];
  }

  async function loadBenchmark(token) {
    const clock = shanghaiClock(now());
    const cutoff = clock.minute >= 15 * 60 + 10 ? clock.date : priorDate(clock.date);
    const input = await withHistorySlot(token, () => deps.fetchBenchmark({ signal: token.controller.signal }));
    if (!current(token)) return null;
    const rows = validBars(input, cutoff, true);
    if (rows.length < MIN_BENCHMARK_BARS) throw new Error(`中证全指有效日线不足 ${MIN_BENCHMARK_BARS} 根：${rows.length}`);
    const asOf = rows.at(-1).date;
    if ((Date.parse(`${clock.date}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) > 14 * 86400000) {
      throw new Error(`中证全指日线陈旧：${asOf}`);
    }
    status.asOf = asOf;
    token.asOf = asOf;
    const closes = rows.slice(-60).map((row) => row.close);
    const ma60 = closes.reduce((sum, close) => sum + close, 0) / 60;
    status.marketGate = rows.at(-1).close >= ma60 ? "open" : "blocked";
    return rows;
  }

  async function assess(token, security, benchmarkRows) {
    if (!current(token)) return;
    const key = JSON.stringify([PIPELINE_VERSION, token.asOf, token.strategySetHash,
      token.benchmarkFingerprint, security]);
    const stored = cache.get(key);
    const age = stored ? new Date(now()).getTime() - stored.createdAt : -1;
    if (!token.forceRefresh && stored && age >= 0 && age < CACHE_TTL_MS) {
      if (!current(token)) return;
      status.performance.cacheHits += 1;
      applyOutcomes(token, security, stored.outcomes, "history", stored.diagnostic);
      return;
    }
    if (stored) cache.delete(key);
    let outcomes;
    let failureKind = "unavailable";
    let diagnostic = { rawValidated: false, recentLimitPassed: false, stage: "raw" };
    try {
      let raw;
      try { raw = await fetchStockHistory(token, security, "none"); }
      catch (error) { failureKind = error?.code === "TREND_DATA_UNAVAILABLE" ? "unavailable" : "failed"; throw error; }
      if (!current(token)) return;
      if (raw?.adjustment !== "none") throw new Error("不复权日线实际复权状态未确认");
      const rawRows = validBars(raw, status.asOf);
      if (!engine().trendMath.prepareRows(rawRows, token.asOf, true)) {
        throw new Error("不复权日线或涨停参考字段无效，无法核验");
      }
      if (rawRows.length < MIN_STOCK_BARS || rawRows.at(-1)?.date !== status.asOf) {
        throw new Error(`不复权日线不足或日期不齐：${rawRows.length}/${MIN_STOCK_BARS}，最新 ${rawRows.at(-1)?.date || "无"}`);
      }
      diagnostic.rawValidated = true;
      diagnostic.stage = "recent-limit";
      const input = { security, rawRows, benchmarkRows, asOf: token.asOf };
      let prefetched = null;
      try { if (prefilter) prefetched = await prefilter(input, token.optionsArray[0]); }
      catch (error) { failureKind = "failed"; throw error; }
      if (!current(token)) return;
      if (prefetched !== null) {
        if (!prefetched || !["excluded", "unavailable"].includes(prefetched.kind)) {
          failureKind = "failed";
          throw new Error("原始日线预筛返回无效结果");
        }
        outcomes = sharedOutcomes(token, prefetched);
        diagnostic.recentLimitPassed = prefetched.kind === "excluded" && /成交额/.test(prefetched.reason || "");
        if (prefetched.kind === "excluded") status.performance.prefilterExcluded += 1;
      } else {
        diagnostic.recentLimitPassed = Boolean(prefilter);
        diagnostic.stage = "adjusted";
        let front;
        try { front = await fetchStockHistory(token, security, "front"); }
        catch (error) { failureKind = error?.code === "TREND_DATA_UNAVAILABLE" ? "unavailable" : "failed"; throw error; }
        if (!current(token)) return;
        if (front?.adjustment !== "front") throw new Error("前复权日线实际复权状态未确认");
        const adjustedRows = validBars(front, status.asOf);
        if (adjustedRows.length < MIN_STOCK_BARS || adjustedRows.at(-1)?.date !== status.asOf) {
          throw new Error(`前复权日线不足或日期不齐：${adjustedRows.length}/${MIN_STOCK_BARS}，最新 ${adjustedRows.at(-1)?.date || "无"}`);
        }
        if (rawRows.slice(-MIN_STOCK_BARS).some((row, index) => row.date !== adjustedRows.at(-MIN_STOCK_BARS + index)?.date)) {
          throw new Error("不复权与前复权最近250根日线日期不齐");
        }
        diagnostic.stage = "trend";
        try { outcomes = await evaluateBatch(token, { ...input, adjustedRows }); }
        catch (error) { failureKind = "failed"; throw error; }
      }
      if (!current(token)) return;
      failureKind = "failed";
      validateOutcomes(token, security, outcomes);
      diagnostic = summarizeStock(outcomes, diagnostic);
      if (outcomes.every(outcome => ["candidate", "excluded"].includes(outcome.kind))) {
        cache.set(key, { outcomes: clone(outcomes), diagnostic: clone(diagnostic), createdAt: new Date(now()).getTime() });
        if (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      }
    } catch (error) {
      if (!current(token)) return;
      if (error?.code === "MARKET_DATA_SOURCE_UNAVAILABLE") {
        token.outage = error;
        token.controller.abort(error);
        throw error;
      }
      if (token.outage) return;
      outcomes = sharedOutcomes(token, { kind: failureKind, reason: errorMessage(error) });
    }
    applyOutcomes(token, security, outcomes, "history", diagnostic);
  }

  function summarizeStock(outcomes, initial) {
    const candidates = outcomes.filter(row => row.kind === "candidate").map(row => row.candidate);
    const triggered = candidates.filter(technicalTriggered);
    const diagnostic = { ...initial,
      recentLimitPassed: initial.recentLimitPassed || candidates.length > 0 || outcomes.some(row => row.kind === "excluded" && /未满足收盘价|涨停后收盘跌破/.test(row.reason || "")),
      trendPassed: candidates.length > 0,
      technicalTriggered: triggered.length > 0,
      riskPassed: triggered.some(row => row.stage === "signal" && row.plan != null)
    };
    // Counts are a monotone, unique-stock funnel. A stock can satisfy any of
    // the selected strategies, and a cached vector replays these same facts.
    let previous = true;
    for (const key of FUNNEL_STAGES) { diagnostic[key] = previous && Boolean(diagnostic[key]); previous = diagnostic[key]; }
    let reasons = [];
    if (diagnostic.trendPassed && !diagnostic.technicalTriggered) {
      reasons = [{ stage: "technical", reason: "所选策略均未触发技术条件" }];
    } else if (diagnostic.technicalTriggered && !diagnostic.riskPassed) {
      reasons = triggered.flatMap(row => (row.evidence || []).filter(item => item.passed === false &&
        !TECHNICAL_LABELS[row.strategy?.id]?.includes(item.label) && !/^[AB]/.test(item.label))
        .map(item => ({ stage: "risk", reason: item.label })));
      if (!reasons.length) reasons = [{ stage: "risk", reason: "技术触发后仍未通过全部质量及风险区间条件" }];
    } else if (!diagnostic.trendPassed) {
      reasons = outcomes.filter(row => row.kind !== "candidate" && row.reason).map(row => ({ stage: diagnostic.stage, reason: row.reason }));
    }
    diagnostic.reasons = [...new Map(reasons.map(row => [`${row.stage}:${row.reason}`, row])).values()];
    return diagnostic;
  }

  function sharedOutcomes(token, outcome) {
    return token.strategies.map(() => outcome);
  }

  async function evaluateBatch(token, input) {
    if (deps.evaluateBatch) return deps.evaluateBatch(input, token.optionsArray);
    if (!deps.evaluateStock) return strategies().evaluateTrendStrategyBatch(input, token.optionsArray);
    // Legacy evaluator injection remains useful for adapter tests. Only this
    // compatibility path supplies a missing snapshot; production must prove it.
    const outcomes = [];
    for (let index = 0; index < token.optionsArray.length; index += 1) {
      if (!current(token)) return null;
      try {
        const outcome = await deps.evaluateStock(input, token.optionsArray[index]);
        outcomes.push(outcome?.kind === "candidate" && outcome.candidate && !outcome.candidate.strategy
          ? { ...outcome, candidate: { ...outcome.candidate, strategy: token.strategies[index] } } : outcome);
      } catch (error) {
        if (error?.code === "MARKET_DATA_SOURCE_UNAVAILABLE") throw error;
        outcomes.push({ kind: "failed", reason: errorMessage(error) });
      }
    }
    return outcomes;
  }

  function validateOutcomes(token, security, outcomes) {
    if (!Array.isArray(outcomes) || outcomes.length !== token.strategies.length) {
      throw new Error("批量规则引擎返回结果数量与策略配置不一致");
    }
    for (const [index, outcome] of outcomes.entries()) {
      if (!outcome || !["candidate", "excluded", "unavailable", "failed"].includes(outcome.kind)) {
        throw new Error("规则引擎返回无效结果");
      }
      if (outcome.kind !== "candidate") continue;
      const candidate = outcome.candidate;
      const expected = token.strategies[index];
      const actual = candidate?.strategy;
      if (!candidate || candidate.security?.code !== security.code ||
          candidate.security?.secid !== security.secid || !actual || actual.id !== expected.id ||
          actual.version !== expected.version || actual.configHash !== expected.configHash ||
          JSON.stringify(actual.config) !== JSON.stringify(expected.config)) {
        throw new Error("规则引擎候选证券或策略版本快照不匹配");
      }
    }
  }

  function applyOutcomes(token, security, outcomes, stage = "history", facts = null) {
    if (!current(token)) return;
    const diagnostic = facts?.reasons ? facts : summarizeStock(outcomes, facts || { stage });
    for (const key of FUNNEL_STAGES) status.diagnostics.funnel[key] += Number(Boolean(diagnostic[key]));
    for (const reason of diagnostic.reasons) {
      const existing = status.diagnostics.reasons.find(row => row.stage === reason.stage && row.reason === reason.reason);
      if (existing) existing.count += 1;
      else status.diagnostics.reasons.push({ ...reason, count: 1 });
    }
    status.processed += 1;
    if (outcomes.some(outcome => outcome.kind === "failed")) status.failed += 1;
    else if (outcomes.some(outcome => outcome.kind === "unavailable")) status.unavailable += 1;
    else if (outcomes.every(outcome => outcome.kind === "excluded")) status.excluded += 1;
    const errors = new Set();
    outcomes.forEach((outcome, index) => {
      const stats = status.strategyStats[index];
      stats.processed += 1;
      if (outcome.kind === "candidate") {
        stats.candidateCount += 1;
        status.candidates.push(clone(outcome.candidate));
      } else {
        stats[outcome.kind] += 1;
        if (outcome.kind !== "excluded") errors.add(String(outcome.reason || "数据不可用"));
      }
    });
    for (const message of errors) fail(token, stage, message, security.code);
    publish(token);
  }

  function rankAll(token, candidates) {
    if (token.strategies.length === 1) return rank(candidates, token.optionsArray[0]);
    const ranked = token.strategies.flatMap((strategy, index) =>
      rank(candidates.filter(candidate => candidate.strategy.id === strategy.id), token.optionsArray[index]));
    return ranked.sort((left, right) => {
      const stage = Number(right.stage === "signal") - Number(left.stage === "signal");
      const leftRS = Number.isFinite(left.metrics?.relativeStrength20) ? left.metrics.relativeStrength20 : -Infinity;
      const rightRS = Number.isFinite(right.metrics?.relativeStrength20) ? right.metrics.relativeStrength20 : -Infinity;
      return stage || (leftRS === rightRS ? 0 : rightRS - leftRS) ||
        left.security.code.localeCompare(right.security.code) || left.strategy.id.localeCompare(right.strategy.id);
    });
  }

  async function scan(token) {
    try {
      const universe = await loadUniverse(token);
      if (!current(token)) return;
      if (status.universeLoaded === 0) throw new Error("全市场证券名单为空，无法确认覆盖范围");
      const benchmarkRows = await loadBenchmark(token);
      if (!current(token)) return;
      const fingerprint = createHash("sha256")
        .update(JSON.stringify(benchmarkRows.slice(-80).map((row) => [row.date, row.close])))
        .digest("hex");
      const basis = `${status.asOf}:${fingerprint}`;
      token.benchmarkFingerprint = fingerprint;
      if (cacheBasis !== basis) { cache.clear(); cacheBasis = basis; }
      status.phase = "scanning";
      status.note = "逐只验证原始日线必要条件；仍可能入选者再核对前复权日线。公开涨停价规则推算待核验，策略收益未经验证。";
      publish(token);
      let cursor = 0;
      const workers = Array.from({ length: Math.min(MAX_HISTORY_CONCURRENCY, universe.length) }, async () => {
        while (current(token) && !token.outage && cursor < universe.length) {
          const security = universe[cursor++];
          await assess(token, security, benchmarkRows);
        }
      });
      await Promise.all(workers);
      if (!current(token)) return;
      status.candidates = rankAll(token, status.candidates);
      status.coverageComplete = status.boards.every((board) => board.complete) &&
        status.processed === status.universeLoaded && status.unavailable === 0 && status.failed === 0;
      status.strategyStats.forEach(item => {
        item.coverageComplete = status.boards.every(board => board.complete) &&
          item.processed === status.universeLoaded && item.unavailable === 0 && item.failed === 0;
      });
      status.phase = "completed";
      status.note = status.coverageComplete
        ? "全市场名单和日线已处理；候选为规则推算、待核验，策略收益未经验证。"
        : "部分覆盖：存在名单缺页或日线不可用；无候选不代表全市场无机会。公开行情规则推算，待核验。";
      publish(token);
    } catch (error) {
      if (!current(token)) return;
      status.phase = "failed";
      status.coverageComplete = false;
      status.marketGate = "unknown";
      status.failed += 1;
      status.strategyStats.forEach(item => { item.failed += 1; item.coverageComplete = false; });
      fail(token, status.asOf ? "scan" : status.universeLoaded ? "benchmark" : "universe", errorMessage(error));
      status.note = `扫描失败：${errorMessage(error)}。无法据此判断全市场。`;
      token.controller.abort(error);
      publish(token);
    } finally {
      if (active === token) active = null;
    }
  }

  return {
    start(options = {}) {
      const normalized = normalizeOptions(options);
      if (active && !active.cancelled) {
        if (active.strategySetHash !== normalized.strategySetHash) {
          throw new Error("另一个策略配置正在扫描，请先取消当前任务再启动新配置");
        }
        return snapshot();
      }
      const startedAt = stamp();
      const selected = clone(normalized.strategies);
      selected.forEach(strategy => { Object.freeze(strategy.config); Object.freeze(strategy); });
      Object.freeze(selected);
      const token = { id: ++generation, cancelled: false, controller: new AbortController(),
        startedClock: clock.now(), strategies: selected, strategySetHash: normalized.strategySetHash,
        forceRefresh: normalized.forceRefresh,
        optionsArray: Object.freeze(selected.map(strategy => Object.freeze({ strategyId: strategy.id, config: strategy.config }))) };
      active = token;
      status = {
        jobId: `${startedAt}:${token.id}`, phase: "loading-universe", startedAt, updatedAt: startedAt,
        asOf: "", universeLoaded: 0, universeExpected: null, processed: 0, excluded: 0,
        unavailable: 0, failed: 0, coverageComplete: false, marketGate: "unknown",
        boards: BOARDS.map(({ id, label }) => ({ id, label, expected: null, loaded: 0, complete: false })),
        candidates: [], errors: [], note: "正在获取全市场名单；公开行情规则推算，待核验。",
        validation: "unvalidated", ...strategyStatus(selected, token.strategySetHash), performance: emptyPerformance(), diagnostics: emptyDiagnostics()
      };
      queueMicrotask(() => { void scan(token); });
      return snapshot();
    },
    getStatus() { return snapshot(); },
    cancel() {
      if (active && !active.cancelled) {
        refreshSources(active);
        active.cancelled = true;
        active.controller.abort(new DOMException("趋势扫描已取消", "AbortError"));
        status.phase = "cancelled";
        status.coverageComplete = false;
        status.strategyStats.forEach(item => { item.coverageComplete = false; });
        status.updatedAt = stamp();
        status.performance.elapsedMs = elapsed(active);
        status.note = "扫描已取消；结果仅为部分覆盖，不能据此认定无候选。";
      }
      return snapshot();
    }
  };
}

module.exports = { createTrendScreenerService };
