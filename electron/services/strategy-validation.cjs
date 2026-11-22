"use strict";
// 从 electron/services.cjs 提取（2026-11-15 审核 P0-2b 拆分）。
// services.cjs 通过顶部解构回本模块并继续按原契约 re-export，勿在这里引入
// 对 services.cjs 的反向依赖。
const { createTradingCalendar } = require("../trend-trading-calendar.cjs");
const { MARKET_SESSIONS: SELECTION_MARKET_SESSIONS } = require("../strategy-selection-service.cjs");
const _runtime = require("./runtime.cjs");
const { serviceRuntime } = _runtime;
function isAStockCode(...args) { return _runtime.isAStockCode(...args); }
function fetchJson(...args) { return _runtime.fetchJson(...args); }
function toSecurity(...args) { return _runtime.toSecurity(...args); }
function serviceSignal(...args) { return _runtime.serviceSignal(...args); }
function trackServiceRequest(...args) { return _runtime.trackServiceRequest(...args); }
const _backtest = require("./backtest.cjs");
function isRiskStockName(...args) { return _backtest.isRiskStockName(...args); }
function clamp(...args) { return _backtest.clamp(...args); }
function strategyDefinitions(...args) { return _backtest.strategyDefinitions(...args); }
const _sectors = require("./sectors.cjs");
function withSingleFlightCache(...args) { return _sectors.withSingleFlightCache(...args); }
const _strategy_scan = require("./strategy-scan.cjs");
const { strategySelectionMarketData } = _strategy_scan;
function strategySignalNumber(...args) { return _strategy_scan.strategySignalNumber(...args); }

const strategyValidationUniverseCache = { value: null, expiresAt: 0, promise: null };

const STRATEGY_SIGNAL_HISTORY_BARS = 720;

const STRATEGY_SIGNAL_VALIDATION_SAMPLE = 120;

function marketFromCode(code) {
  if (/^(6|68)/.test(code)) return 1;
  return 0;
}

function strategyBoardBucket(code = "") {
  const value = String(code);
  if (/^(300|301|302)/.test(value)) return "创业板";
  if (/^(688|689)/.test(value)) return "科创板";
  if (/^(4|8|9)/.test(value)) return "北交所";
  if (/^(6|000|001|002|003)/.test(value)) return "沪深主板";
  return "其他";
}

function strategyValidationBoard(code = "") {
  const value = String(code);
  if (/^(300|301|302)/.test(value)) return "growth";
  if (/^(688|689)/.test(value)) return "star";
  if (/^(4|8|9)/.test(value)) return "beijing";
  return "main";
}

function stableStrategySampleHash(value = "") {
  let hash = 2166136261;
  for (const character of String(value)) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function selectIndependentValidationSample(
  securities = [],
  limit = STRATEGY_SIGNAL_VALIDATION_SAMPLE,
  excludedCodes = []
) {
  const target = Math.max(1, Math.round(Number(limit) || STRATEGY_SIGNAL_VALIDATION_SAMPLE));
  const excluded = new Set((Array.isArray(excludedCodes) ? excludedCodes : []).map(String));
  const unique = new Map();
  for (const security of Array.isArray(securities) ? securities : []) {
    const code = String(security?.code || security?.f12 || "");
    const name = String(security?.name || security?.f14 || code);
    if (!isAStockCode(code) || excluded.has(code) || isRiskStockName(name)) continue;
    if (!unique.has(code)) {
      unique.set(code, {
        ...security,
        code,
        name,
        secid: String(security?.secid || `${marketFromCode(code)}.${code}`),
        thscode: String(
          security?.thscode ||
          `${code}.${marketFromCode(code) === 1 ? "SH" : /^(4|8|9)/.test(code) ? "BJ" : "SZ"}`
        ),
        industry: String(security?.industry || security?.f100 || "未分类"),
        validationSample: true
      });
    }
  }
  const rows = [...unique.values()];
  const quotaRates = { main: 0.5, growth: 0.25, star: 0.15, beijing: 0.1 };
  const selected = [];
  const selectedCodes = new Set();
  const pickBoard = (board, quota) => {
    const byIndustry = new Map();
    for (const row of rows.filter((item) => strategyValidationBoard(item.code) === board)) {
      const industry = String(row.industry || "未分类");
      const bucket = byIndustry.get(industry) || [];
      bucket.push(row);
      byIndustry.set(industry, bucket);
    }
    const industries = [...byIndustry.keys()].sort();
    for (const industry of industries) {
      byIndustry.get(industry).sort(
        (left, right) =>
          stableStrategySampleHash(left.code) - stableStrategySampleHash(right.code) ||
          left.code.localeCompare(right.code)
      );
    }
    let picked = 0;
    while (selected.length < target && picked < quota && industries.length) {
      let added = false;
      for (const industry of industries) {
        const row = byIndustry.get(industry).shift();
        if (!row || selectedCodes.has(row.code)) continue;
        selected.push(row);
        selectedCodes.add(row.code);
        picked += 1;
        added = true;
        if (picked >= quota || selected.length >= target) break;
      }
      if (!added) break;
    }
  };
  for (const board of ["main", "growth", "star", "beijing"]) {
    pickBoard(board, Math.round(target * quotaRates[board]));
  }
  const remainder = rows
    .filter((row) => !selectedCodes.has(row.code))
    .sort(
      (left, right) =>
        stableStrategySampleHash(`${strategyValidationBoard(left.code)}:${left.industry}:${left.code}`) -
          stableStrategySampleHash(`${strategyValidationBoard(right.code)}:${right.industry}:${right.code}`) ||
        left.code.localeCompare(right.code)
    );
  for (const row of remainder) {
    if (selected.length >= target) break;
    selected.push(row);
    selectedCodes.add(row.code);
  }
  return selected;
}

const SINA_MARKET_CENTER = "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.";

const SINA_BROAD_PAGE_SIZE = 100;

const SINA_BROAD_MAX_PAGES = 60;

// 东方财富 push2delay 的 clist 接口当日整体返回空（curl 52），
// 导致宽基独立样本永远 0/0、所有策略卡在发布门槛、页面一只股票都不显示。
// 这里改用已实测可用的新浪 hs_a 节点，并显式核对其声明的股票总数。
async function sinaBroadUniversePage(page) {
  const url = `${SINA_MARKET_CENTER}getHQNodeData?page=${page}&num=${SINA_BROAD_PAGE_SIZE}` +
    "&sort=symbol&asc=1&node=hs_a&symbol=&_s_r_a=page";
  const rows = await fetchJson(url, {}, 15000);
  if (!Array.isArray(rows)) throw new Error("证券列表为空");
  return rows;
}

async function sinaBroadUniverseDeclaredTotal() {
  const value = await fetchJson(`${SINA_MARKET_CENTER}getHQNodeStockCount?node=hs_a`, {}, 12000);
  const total = Number(typeof value === "string" ? value.replace(/["\s]/g, "") : value);
  return Number.isSafeInteger(total) && total > 0 && total <= 20000 ? total : null;
}

async function broadAStockValidationUniverse() {
  return withSingleFlightCache(strategyValidationUniverseCache, 30 * 60 * 1000, async () => {
    const declaredTotal = await sinaBroadUniverseDeclaredTotal().catch(() => null);
    const all = [];
    const failures = [];
    const seen = new Set();
    let page = 1;
    let complete = false;
    try {
      for (; page <= SINA_BROAD_MAX_PAGES; page += 1) {
        const rows = await sinaBroadUniversePage(page);
        if (!rows.length) { complete = true; break; }
        let added = 0;
        for (const item of rows) {
          const code = String(item?.code || "");
          if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
          seen.add(code);
          all.push(item);
          added += 1;
        }
        // 声明总数已达成且本页无新增，说明分页已到末尾。
        if (declaredTotal !== null && all.length >= declaredTotal && added === 0) { complete = true; break; }
      }
      if (!complete && declaredTotal !== null && all.length >= declaredTotal) complete = true;
    } catch (error) {
      failures.push({
        marketFilter: "sina:hs_a",
        reason: error instanceof Error ? error.message : String(error || "unknown")
      });
    }
    if (!all.length) {
      const rows = [];
      Object.defineProperty(rows, "failures", { value: failures.length ? failures : [{ marketFilter: "sina:hs_a", reason: "未取得宽基证券列表" }], enumerable: false });
      return rows;
    }
    const rows = all.map((item) => ({
      code: String(item.code || ""),
      name: String(item.name || item.code || ""),
      industry: "未分类",
      totalMarketCap: null
    }));
    Object.defineProperty(rows, "failures", {
      value: failures,
      enumerable: false
    });
    return rows;
  });
}

function buildStrategySampleDiversity(candidates = []) {
  const rows = (Array.isArray(candidates) ? candidates : []).filter((item) =>
    isAStockCode(String(item?.code || ""))
  );
  const boardBuckets = {};
  const dateCohorts = {};
  const industries = new Set();
  for (const item of rows) {
    const board = strategyBoardBucket(item.code);
    boardBuckets[board] = Number(boardBuckets[board] || 0) + 1;
    const date = String(item.limitDate || item.date || item.tradeDate || "").slice(0, 10);
    if (date) dateCohorts[date] = Number(dateCohorts[date] || 0) + 1;
    const industry = String(item.industry || "").trim();
    if (industry && industry !== "未分类") industries.add(industry);
  }
  const maximumShare = (counts) => {
    const values = Object.values(counts).map(Number).filter(Number.isFinite);
    return rows.length && values.length
      ? Math.max(...values) / rows.length
      : null;
  };
  const boardCount = Object.keys(boardBuckets).length;
  const dateCohortCount = Object.keys(dateCohorts).length;
  const maximumBoardShare = maximumShare(boardBuckets);
  const maximumDateCohortShare = maximumShare(dateCohorts);
  return {
    securities: rows.length,
    boardCount,
    dateCohortCount,
    industryOrThemeCount: industries.size,
    boardBuckets,
    dateCohorts,
    maximumBoardShare,
    maximumDateCohortShare,
    concentrationWarnings: [
      Number(maximumBoardShare) > 0.8
        ? `最大板块样本占比 ${(Number(maximumBoardShare) * 100).toFixed(1)}%，当前样本仍偏向沪深主板。`
        : ""
    ].filter(Boolean),
    diversified:
      rows.length >= 100 &&
      boardCount >= 4 &&
      dateCohortCount >= 5 &&
      industries.size >= 15 &&
      Number(maximumDateCohortShare) <= 0.35
  };
}

function strategySignalGrade(score) {
  const value = strategySignalNumber(score);
  if (value === null) return "--";
  if (value >= 88) return "A";
  if (value >= 78) return "B";
  if (value >= 68) return "C";
  return "D";
}

function strategyValidationAliases(validation = {}) {
  const outOfSample = validation?.outOfSample || {};
  const walkForward = validation?.walkForward || {};
  const inSample = validation?.inSample || {};
  const winRate5 = strategySignalNumber(outOfSample.winRate, validation.winRate);
  const average5 = strategySignalNumber(
    outOfSample.averageReturn,
    validation.averageReturn
  );
  const excess5 = strategySignalNumber(
    outOfSample.averageExcessReturn,
    validation.averageExcessReturn
  );
  const worstMdd5 = strategySignalNumber(
    outOfSample.maxDrawdown,
    validation.maxDrawdown
  );
  const walkForwardPassRate = strategySignalNumber(walkForward.passRate);
  const positiveFoldRate = strategySignalNumber(walkForward.positiveFoldRate);
  const degradationPercent = strategySignalNumber(walkForward.degradationPercent);
  const stabilityScore =
    walkForward.available === true &&
    walkForwardPassRate !== null &&
    positiveFoldRate !== null &&
    degradationPercent !== null
      ? Math.round(
        clamp(walkForwardPassRate, 0, 1) * 60 +
        clamp(positiveFoldRate, 0, 1) * 25 +
        (1 - clamp(degradationPercent / 100, 0, 1)) * 15
      )
      : null;
  const accepted = validation.accepted === true;
  const minimumSamples = strategySignalNumber(
    validation.minimumSamples,
    validation?.thresholds?.minSamples
  );
  const sampleCount = strategySignalNumber(validation.sampleCount) || 0;
  const status = accepted
    ? "PASS"
    : minimumSamples !== null && sampleCount < minimumSamples
      ? "INSUFFICIENT"
      : "REVIEW";
  const grade = accepted
    ? stabilityScore !== null && stabilityScore >= 85
      ? "A"
      : stabilityScore !== null && stabilityScore >= 70
        ? "B"
        : "C"
    : "D";
  const failureReasons = Array.isArray(validation.reasons)
    ? validation.reasons.filter(Boolean).map(String)
    : validation.reason && !accepted
      ? [String(validation.reason)]
      : [];
  const walkForwardWindows = (Array.isArray(walkForward.folds)
    ? walkForward.folds
    : []
  ).map((fold) => ({
    fold: Number(fold?.fold || 0),
    trainingFrom: String(fold?.trainRange?.from || ""),
    trainingTo: String(fold?.trainRange?.to || ""),
    trainingTrades: Number(fold?.trainSampleCount || 0),
    outOfSampleFrom: String(fold?.testRange?.from || ""),
    outOfSampleTo: String(fold?.testRange?.to || ""),
    outOfSampleTrades: Number(fold?.testSampleCount || 0),
    outOfSampleAverageReturn: strategySignalNumber(fold?.testAverageReturn),
    outOfSampleWinRate: strategySignalNumber(fold?.testWinRate),
    outOfSampleMaxDrawdown: strategySignalNumber(fold?.testMaxDrawdown),
    accepted: fold?.accepted === true
  }));
  const validationEvidence = {
    accepted,
    signalFrom: String(validation?.range?.from || ""),
    signalTo: String(validation?.range?.to || ""),
    totalTrades: sampleCount,
    winningTrades: Number(validation.winCount || 0),
    losingTrades: Number(validation.lossCount || 0),
    excludedUntradeableTrades: Number(validation.untradeableCount || 0),
    training: {
      from: String(inSample?.range?.from || ""),
      to: String(inSample?.range?.to || ""),
      trades: Number(inSample?.sampleCount || 0),
      winRate: strategySignalNumber(inSample?.winRate),
      averageReturn: strategySignalNumber(inSample?.averageReturn),
      maxDrawdown: strategySignalNumber(inSample?.maxDrawdown),
      benchmarkMatchedTrades: Number(inSample?.benchmarkSampleCount || 0)
    },
    outOfSample: {
      from: String(outOfSample?.range?.from || ""),
      to: String(outOfSample?.range?.to || ""),
      trades: Number(outOfSample?.sampleCount || 0),
      winRate: strategySignalNumber(outOfSample?.winRate),
      averageReturn: strategySignalNumber(outOfSample?.averageReturn),
      averageExcessReturn: strategySignalNumber(
        outOfSample?.averageExcessReturn
      ),
      maxDrawdown: strategySignalNumber(outOfSample?.maxDrawdown),
      benchmarkMatchedTrades: Number(
        outOfSample?.benchmarkSampleCount || 0
      )
    },
    walkForward: {
      available: walkForward.available === true,
      accepted: walkForward.accepted === true,
      folds: walkForwardWindows.length,
      passedFolds: Number(walkForward.passedFolds || 0),
      passRate: walkForwardPassRate,
      windows: walkForwardWindows
    },
    execution: {
      holdingTradingDays: Number(validation.horizonDays || 0),
      roundTripCostBps: strategySignalNumber(validation.roundTripCostBps),
      roundTripCostPercent:
        strategySignalNumber(validation.roundTripCostBps) === null
          ? null
          : Number(validation.roundTripCostBps) / 100,
      entryRule: String(validation.entryRule || ""),
      returnType: String(validation.returnType || "")
    },
    benchmark: {
      code: "000985",
      name: "中证全指",
      matchedTrades: Number(validation.benchmarkSampleCount || 0),
      totalTrades: sampleCount,
      missingTrades: Math.max(
        0,
        sampleCount - Number(validation.benchmarkSampleCount || 0)
      ),
      complete:
        sampleCount > 0 &&
        Number(validation.benchmarkSampleCount || 0) >= sampleCount,
      averageExcessReturn: strategySignalNumber(
        validation.averageExcessReturn
      )
    },
    failureReasons
  };
  return {
    ...validation,
    outOfSampleCount:
      strategySignalNumber(outOfSample.sampleCount) || 0,
    walkForwardPassRate,
    winRate5,
    average5,
    excess5,
    worstMdd5,
    stabilityScore,
    status,
    grade,
    failureReasons,
    validationEvidence
  };
}

function enrichStrategySignalReport(report = {}, candidates = [], context = {}) {
  const candidateByCode = new Map(
    (Array.isArray(candidates) ? candidates : [])
      .filter((item) => isAStockCode(String(item?.code || "")))
      .map((item) => [String(item.code), item])
  );
  const reportStrategies = Array.isArray(report?.strategies)
    ? report.strategies
    : [];
  const availableIds = new Set(reportStrategies.map((strategy) => String(strategy.id)));
  const isCompositeStrategy = (strategy) => {
    const type = String(strategy?.type || "").toLowerCase();
    if (type) return type === "composite";
    return Array.isArray(strategy?.components) && strategy.components.length > 0;
  };
  const requestedIds = Array.isArray(context.strategyIds)
    ? new Set(
      context.strategyIds
        .map(String)
        .filter((id) => availableIds.has(id))
    )
    : null;
  const maxStocksPerStrategy = Math.max(
    1,
    Math.min(140, Math.round(Number(context.maxStocksPerStrategy) || 140))
  );
  const auditedStrategies = reportStrategies
    .filter((strategy) => !requestedIds?.size || requestedIds.has(String(strategy.id)))
    .map((strategy) => {
      const validation = strategyValidationAliases(strategy.validation);
      const benchmarkReady =
        context.benchmarkFailed !== true &&
        (
          context.benchmarkBars === undefined ||
          Number(context.benchmarkBars) >= 420
        );
      const totalTrades = Number(validation.sampleCount || 0);
      const outOfSampleTrades = Number(
        validation?.outOfSample?.sampleCount || 0
      );
      const walkForwardWindows = Array.isArray(
        validation?.walkForward?.folds
      )
        ? validation.walkForward.folds.length
        : 0;
      const walkForwardPassRate = Number(
        validation?.walkForward?.passRate || 0
      );
      const benchmarkMatchedTrades = Number(
        validation?.outOfSample?.benchmarkSampleCount || 0
      );
      const totalBenchmarkMatchedTrades = Number(
        validation?.benchmarkSampleCount || 0
      );
      const robustValidation = validation?.validationVersion === "robust-v2";
      const outOfSampleExcess = strategySignalNumber(
        validation?.outOfSample?.averageExcessReturn
      );
      const outOfSampleLowerBound = strategySignalNumber(
        validation?.outOfSample?.averageReturnLowerBound95
      );
      const currentRegimeFit = validation?.currentRegimeFit || {};
      const minimumTotalTrades = Math.max(
        30,
        Number(validation?.thresholds?.minSamples || 30)
      );
      const minimumOutOfSampleTrades = Math.max(
        9,
        Number(validation?.thresholds?.minOutOfSampleSamples || 9)
      );
      const publicationFailureReasons = [
        ...validation.failureReasons
      ];
      if (totalTrades < minimumTotalTrades) {
        publicationFailureReasons.push(
          `总交易样本不足：${totalTrades}/${minimumTotalTrades}。`
        );
      }
      if (outOfSampleTrades < minimumOutOfSampleTrades) {
        publicationFailureReasons.push(
          `样本外交易不足：${outOfSampleTrades}/${minimumOutOfSampleTrades}。`
        );
      }
      if (walkForwardWindows < 3) {
        publicationFailureReasons.push(
          `连续走步窗口不足：${walkForwardWindows}/3。`
        );
      }
      if (walkForwardPassRate < 2 / 3) {
        publicationFailureReasons.push(
          `走步窗口通过率不足：${(walkForwardPassRate * 100).toFixed(1)}%/66.7%。`
        );
      }
      if (!benchmarkReady) {
        publicationFailureReasons.push(
          "中证全指（000985）基准历史不足420根或不可用，不能发布策略信号。"
        );
      }
      if (benchmarkMatchedTrades < outOfSampleTrades) {
        publicationFailureReasons.push(
          `基准可比交易不足：${benchmarkMatchedTrades}/${outOfSampleTrades}。`
        );
      }
      if (totalBenchmarkMatchedTrades < totalTrades) {
        publicationFailureReasons.push(
          `全部样本基准可比交易不足：${totalBenchmarkMatchedTrades}/${totalTrades}。`
        );
      }
      if (robustValidation && !(Number(outOfSampleExcess) > 0)) {
        publicationFailureReasons.push(
          "样本外相对中证全指超额收益未转正，不发布当前信号。"
        );
      }
      if (robustValidation && !(Number(outOfSampleLowerBound) >= 0)) {
        publicationFailureReasons.push(
          "样本外平均收益95%单侧置信下限未达到0%，不发布当前信号。"
        );
      }
      if (robustValidation && currentRegimeFit.supported !== true) {
        publicationFailureReasons.push(
          String(currentRegimeFit.reason || "当前市场状态缺少通过复核的历史优势。")
        );
      }
      if (robustValidation && context.independentValidationUniverse !== true) {
        publicationFailureReasons.push(
          "独立于当前涨停候选池的宽基验证样本不足，不发布当前信号。"
        );
      }
      const publicationAccepted =
        validation.accepted === true &&
        validation?.walkForward?.accepted === true &&
        totalTrades >= minimumTotalTrades &&
        outOfSampleTrades >= minimumOutOfSampleTrades &&
        walkForwardWindows >= 3 &&
        walkForwardPassRate >= 2 / 3 &&
        benchmarkReady &&
        totalBenchmarkMatchedTrades >= totalTrades &&
        benchmarkMatchedTrades >= outOfSampleTrades &&
        (!robustValidation ||
          (
            Number(outOfSampleExcess) > 0 &&
            Number(outOfSampleLowerBound) >= 0 &&
            currentRegimeFit.supported === true &&
            context.independentValidationUniverse === true
          ));
      const publicationChecks = {
        strategyType: isCompositeStrategy(strategy) ? "composite" : "base",
        thresholdProfile: "uniform_v1",
        sameThresholdsAsBaseStrategy: true,
        engineAccepted: validation.accepted === true,
        minimumTotalTrades,
        totalTrades,
        minimumOutOfSampleTrades,
        outOfSampleTrades,
        minimumWalkForwardWindows: 3,
        walkForwardWindows,
        minimumWalkForwardPassRate: 2 / 3,
        walkForwardPassRate,
        minimumBenchmarkBars: 420,
        benchmarkBars: Number(context.benchmarkBars || 0),
        totalBenchmarkMatchedTrades,
        benchmarkMatchedTrades,
        outOfSampleExcess,
        minimumOutOfSampleExcess: 0,
        outOfSampleReturnLowerBound95: outOfSampleLowerBound,
        minimumOutOfSampleReturnLowerBound95: 0,
        currentRegimeFit,
        independentValidationUniverse:
          context.independentValidationUniverse === true,
        passed: publicationAccepted
      };
      const validationEvidence = {
        ...validation.validationEvidence,
        benchmark: {
          ...validation.validationEvidence.benchmark,
          bars: Number(context.benchmarkBars || 0),
          from: String(context?.dataQuality?.benchmark?.from || ""),
          to: String(context?.dataQuality?.benchmark?.to || ""),
          provider: String(context?.dataQuality?.benchmark?.provider || ""),
          adjustment: "不复权",
          available: benchmarkReady
        },
        sourceData: {
          from: String(context?.dataQuality?.dataRange?.from || ""),
          to: String(context?.dataQuality?.dataRange?.to || ""),
          requestedBars: Number(context.historyBarsRequested || 0),
          usableSecurities: Number(context.processed || 0),
          failedSecurities: Number(context.failed || 0),
          providers: context?.dataQuality?.summary?.providers || {}
        },
        publicationChecks,
        publicationAccepted,
        failureReasons: publicationFailureReasons
      };
      const validationWithEvidence = {
        ...validation,
        publicationAccepted,
        publicationFailureReasons,
        validationEvidence
      };
      const stocks = (Array.isArray(strategy.stocks) ? strategy.stocks : [])
        .filter(
          (stock) =>
            !robustValidation ||
            (
              stock?.matchSource === "ohlcv" &&
              Number(stock?.historyBars || 0) >= 120
            )
        )
        .map((stock) => {
          const candidate = candidateByCode.get(String(stock?.code || "")) || {};
          const analysis = candidate?.analysis || {};
          const signalScore =
            strategySignalNumber(
              stock?.signalStrength,
              stock?.signalScore,
              stock?.score
            );
          const strategyMatchRate =
            strategySignalNumber(
              candidate?.strategyMatchRate,
              analysis?.strategyMatchRate
            );
          return {
            ...stock,
            code: String(stock?.code || candidate?.code || ""),
            name: String(stock?.name || candidate?.name || stock?.code || ""),
            secid: String(candidate?.secid || stock?.secid || ""),
            thscode: String(candidate?.thscode || stock?.thscode || ""),
            latest: strategySignalNumber(stock?.latest, candidate?.latest),
            changePct: strategySignalNumber(stock?.changePct, candidate?.changePct),
            turnover: strategySignalNumber(candidate?.turnover, stock?.turnover),
            amount: strategySignalNumber(candidate?.amount, stock?.amount),
            industry: String(
              candidate?.industry || stock?.industry || "未分类"
            ),
            observationNode: String(
              candidate?.observationNode || stock?.observationNode || ""
            ),
            limitDate: String(candidate?.limitDate || stock?.signalDate || ""),
            tradingDaysSince: strategySignalNumber(candidate?.tradingDaysSince),
            consecutiveBoards: strategySignalNumber(
              candidate?.consecutiveBoards,
              candidate?.limitStats?.count,
              stock?.metrics?.consecutiveBoards
            ),
            firstSealTime: String(candidate?.firstSealTime || ""),
            openBoardCount: strategySignalNumber(candidate?.openBoardCount),
            sealedAmount: strategySignalNumber(candidate?.sealedAmount),
            sealFloatRatio: strategySignalNumber(candidate?.sealFloatRatio),
            signalScore,
            score: signalScore,
            mrs: strategySignalNumber(candidate?.mrs, analysis?.mrs),
            strategyMatchRate:
              strategyMatchRate === null
                ? null
                : Math.round(clamp(strategyMatchRate, 0, 100)),
            grade: strategySignalGrade(signalScore),
            validationPassed: publicationAccepted
          };
        })
        .sort(
          (left, right) =>
            Number(right.signalScore || 0) - Number(left.signalScore || 0) ||
            String(left.code).localeCompare(String(right.code))
        )
        .slice(0, maxStocksPerStrategy)
        .map((stock, index) => ({ ...stock, rank: index + 1 }));
      return {
        ...strategy,
        validation: validationWithEvidence,
        validationPassed: publicationAccepted,
        publicationAccepted,
        validationWarning: publicationAccepted
          ? ""
          : publicationFailureReasons.join("；"),
        stocks
      };
    })
    .sort(
      (left, right) =>
        Number(right.publicationAccepted) - Number(left.publicationAccepted) ||
        Number(right.validation.accepted) - Number(left.validation.accepted) ||
        Number(right.validation.stabilityScore || 0) -
          Number(left.validation.stabilityScore || 0) ||
        Number(right.validation.average5 || 0) -
          Number(left.validation.average5 || 0) ||
        Number(right.validation.winRate5 || 0) -
          Number(left.validation.winRate5 || 0) ||
        Number(right.validation.sampleCount || 0) -
          Number(left.validation.sampleCount || 0)
    )
    .map((strategy, index) => ({
      ...strategy,
      auditRank: index + 1
    }));
  // 用户要的是"按策略选出票"。规则命中本身就是选股结果，必须返回；
  // 历史复核是否通过只作为质量标注（validationPassed / publicationAccepted），
  // 不再作为"是否显示股票"的开关——否则一次复核失败会让整页一只都不显示。
  const strategies = auditedStrategies.map((strategy, index) => ({
    ...strategy,
    strategyRank: index + 1,
    stocks: strategy.stocks.map((stock) => ({
      ...stock,
      validationPassed: strategy.publicationAccepted === true
    }))
  }));
  const publishedStrategies = strategies.filter((strategy) => strategy.publicationAccepted === true);
  const rawOptimizedPortfolio = report?.optimizedPortfolio;
  let optimizedPortfolio = null;
  if (rawOptimizedPortfolio && typeof rawOptimizedPortfolio === "object") {
    const optimizedFailureReasons = [];
    const optimizedValidation = rawOptimizedPortfolio?.validation || {};
    const optimizedTerminalHoldout =
      rawOptimizedPortfolio?.terminalHoldout || {};
    const optimizedBenchmarkReady =
      context.benchmarkFailed !== true &&
      Number(context.benchmarkBars || 0) >= 420;
    const optimizedDevelopmentTrades = Number(
      optimizedValidation.sampleCount || 0
    );
    const optimizedDevelopmentBenchmarkTrades = Number(
      optimizedValidation.benchmarkSampleCount || 0
    );
    const optimizedDevelopmentBenchmarkComplete =
      optimizedDevelopmentTrades > 0 &&
      optimizedDevelopmentBenchmarkTrades >= optimizedDevelopmentTrades;
    const optimizedTerminalTrades = Number(
      optimizedTerminalHoldout.sampleCount || 0
    );
    const optimizedTerminalBenchmarkTrades = Number(
      optimizedTerminalHoldout.benchmarkSampleCount || 0
    );
    const optimizedTerminalBenchmarkComplete =
      optimizedTerminalTrades > 0 &&
      optimizedTerminalBenchmarkTrades >= optimizedTerminalTrades;
    if (rawOptimizedPortfolio.accepted !== true) {
      optimizedFailureReasons.push(
        String(rawOptimizedPortfolio.reason || "稳健优选组合未通过引擎复核。")
      );
    }
    if (context.independentValidationUniverse !== true) {
      optimizedFailureReasons.push(
        "独立于当前涨停候选池的宽基样本不足，组合不发布。"
      );
    }
    if (!optimizedBenchmarkReady) {
      optimizedFailureReasons.push(
        "中证全指（000985）基准历史不足420根或不可用，组合不发布。"
      );
    }
    if (!optimizedDevelopmentBenchmarkComplete) {
      optimizedFailureReasons.push(
        `组合开发期基准可比交易不足：${optimizedDevelopmentBenchmarkTrades}/${optimizedDevelopmentTrades}。`
      );
    }
    if (!optimizedTerminalBenchmarkComplete) {
      optimizedFailureReasons.push(
        `组合终端留出基准可比交易不足：${optimizedTerminalBenchmarkTrades}/${optimizedTerminalTrades}。`
      );
    }
    if (rawOptimizedPortfolio?.terminalHoldout?.accepted !== true) {
      optimizedFailureReasons.push(
        String(rawOptimizedPortfolio?.terminalHoldout?.reason || "终端留出样本未通过。")
      );
    }
    if (rawOptimizedPortfolio?.currentRegimeFit?.supported !== true) {
      optimizedFailureReasons.push(
        String(rawOptimizedPortfolio?.currentRegimeFit?.reason || "当前市场状态未通过适配复核。")
      );
    }
    const optimizedPublicationAccepted =
      rawOptimizedPortfolio.accepted === true &&
      rawOptimizedPortfolio?.terminalHoldout?.accepted === true &&
      rawOptimizedPortfolio?.currentRegimeFit?.supported === true &&
      optimizedBenchmarkReady &&
      optimizedDevelopmentBenchmarkComplete &&
      optimizedTerminalBenchmarkComplete &&
      context.independentValidationUniverse === true;
    const optimizedCandidateStocks = (Array.isArray(rawOptimizedPortfolio.stocks)
      ? rawOptimizedPortfolio.stocks
      : [])
      .filter(
        (stock) =>
          stock?.matchSource === "ohlcv" &&
          Number(stock?.historyBars || 0) >= 120
      )
      .map((stock) => {
        const candidate = candidateByCode.get(String(stock?.code || "")) || {};
        return {
          ...stock,
          code: String(stock?.code || candidate?.code || ""),
          name: String(stock?.name || candidate?.name || stock?.code || ""),
          secid: String(candidate?.secid || stock?.secid || ""),
          thscode: String(candidate?.thscode || stock?.thscode || ""),
          latest: strategySignalNumber(stock?.latest, candidate?.latest),
          changePct: strategySignalNumber(stock?.changePct, candidate?.changePct),
          turnover: strategySignalNumber(candidate?.turnover, stock?.turnover),
          amount: strategySignalNumber(candidate?.amount, stock?.amount),
          industry: String(candidate?.industry || stock?.industry || "未分类"),
          signalScore: strategySignalNumber(stock?.signalStrength, stock?.signalScore),
          score: strategySignalNumber(stock?.signalStrength, stock?.signalScore),
          grade: strategySignalGrade(stock?.signalStrength),
          validationPassed: optimizedPublicationAccepted
        };
      });
    optimizedPortfolio = {
      ...rawOptimizedPortfolio,
      accepted: optimizedPublicationAccepted,
      engineAccepted: rawOptimizedPortfolio.accepted === true,
      publicationAccepted: optimizedPublicationAccepted,
      publicationFailureReasons: [...new Set(optimizedFailureReasons.filter(Boolean))],
      benchmarkChecks: {
        minimumBars: 420,
        bars: Number(context.benchmarkBars || 0),
        available: optimizedBenchmarkReady,
        development: {
          complete: optimizedDevelopmentBenchmarkComplete,
          matchedTrades: optimizedDevelopmentBenchmarkTrades,
          totalTrades: optimizedDevelopmentTrades
        },
        terminalHoldout: {
          complete: optimizedTerminalBenchmarkComplete,
          matchedTrades: optimizedTerminalBenchmarkTrades,
          totalTrades: optimizedTerminalTrades
        }
      },
      independentValidationUniverse:
        context.independentValidationUniverse === true,
      matchedStockCount: optimizedCandidateStocks.length,
      stocks: optimizedPublicationAccepted ? optimizedCandidateStocks : []
    };
  }
  const matchedCodes = new Set(
    auditedStrategies.flatMap((strategy) =>
      strategy.stocks.map((stock) => stock.code)
    )
  );
  const qualifiedCodes = new Set(
    publishedStrategies.flatMap((strategy) => strategy.stocks.map((stock) => stock.code))
  );
  for (const stock of optimizedPortfolio?.stocks || []) {
    qualifiedCodes.add(String(stock.code));
  }
  const unvalidatedSignals = auditedStrategies.reduce(
    (total, strategy) =>
      total +
      (strategy.publicationAccepted ? 0 : strategy.stocks.length),
    0
  );
  const warnings = [];
  if (Number(context.failed) > 0) {
    warnings.push(
      `${Number(context.failed)} 只股票的历史行情获取失败，已隔离，不影响其余股票选股。`
    );
  }
  if (Number(context.availableUniverseSize) > Number(context.universeSize)) {
    warnings.push(
      `最近11个交易日共有 ${Number(context.availableUniverseSize)} 只非ST涨停候选；为控制行情源压力，本轮按新近度、连板与成交额扫描前 ${Number(context.universeSize)} 只。`
    );
  }
  if (context.benchmarkFailed) {
    warnings.push("中证全指基准历史暂不可用，超额收益保持为空，不进行补造。");
  }
  if (context.independentValidationUniverse !== true) {
    warnings.push(
      `宽基独立验证可用样本 ${Number(context.independentValidationUsableSampleSize || 0)}/${Number(context.independentValidationSampleSize || 0)} 只，或板块覆盖未达到发布要求；${String(context.broadUniverseError || "本轮只保留审计结果").slice(0, 160)}。`
    );
  }
  if (unvalidatedSignals > 0) {
    warnings.push(
      `本轮全部 ${unvalidatedSignals} 条命中已按所属策略列出，可直接查看个股与带入回测。`
    );
  }
  if (!matchedCodes.size) {
    warnings.push("当前真实候选池没有股票满足任何策略规则，未补造策略信号。");
  }
  const methodologyDetails = report?.methodology || {};
  const methodology = typeof methodologyDetails === "string"
    ? methodologyDetails
    : Object.values(methodologyDetails).filter(Boolean).join("；");
  const strategyAudit = auditedStrategies.map((strategy) => ({
    id: strategy.id,
    name: strategy.name,
    ...(strategy.version ? { version: strategy.version, sources: strategy.sources,
      parameters: strategy.parameters, adaptationNote: strategy.adaptationNote,
      componentNames: strategy.componentNames } : {}),
    detail: strategy.detail,
    type: strategy.type,
    components: strategy.components,
    voteRule: strategy.voteRule,
    accepted: strategy.validation.accepted === true,
    publicationAccepted: strategy.publicationAccepted === true,
    currentMatchCount: strategy.stocks.length,
    sampleCount: Number(strategy.validation.sampleCount || 0),
    failureReasons: strategy.validation.publicationFailureReasons,
    evidence: strategy.validation.validationEvidence
  }));
  const historyProviders = Object.keys(
    context?.dataQuality?.summary?.providers || {}
  );
  const selectionBiasWarningV2 = context.independentValidationUniverse === true
    ? `历史验证已加入 ${Number(context.independentValidationSampleSize || 0)} 只不属于当前涨停候选池的宽基分层样本，降低当前候选选择偏差；但仍使用当前可交易证券回放，不等同于历史时点成分股数据库，仍可能有幸存者偏差。`
    : "本轮未取得足量的宽基独立样本，仍存在当前候选选择偏差与幸存者偏差；结果只作审计，不发布稳健优选组合。";
  const historyProviderLabel = historyProviders.length && historyProviders.every((item) => item.startsWith("ths"))
    ? "同花顺"
    : historyProviders.some((item) =>
    item.startsWith("tencent")
  )
    ? "腾讯证券"
    : historyProviders.some((item) => item.startsWith("sina"))
      ? "新浪财经"
    : historyProviders.some((item) => item === "eastmoney")
      ? "东方财富"
      : "公开行情源";
  const poolProviders = Array.isArray(context.poolProviders)
    ? context.poolProviders.map(String)
    : [];
  const poolProviderLabel = poolProviders.some((item) => item.startsWith("ths"))
    ? "同花顺公开涨停池"
    : poolProviders.some((item) => item.startsWith("eastmoney"))
      ? "东方财富涨停专题池"
      : "公开涨停池";
  const benchmarkProvider = String(
    context?.dataQuality?.benchmark?.provider || ""
  );
  const benchmarkProviderLabel = benchmarkProvider.startsWith("fuyao")
    ? "同花顺扶摇"
    : benchmarkProvider.startsWith("tencent")
    ? "腾讯证券"
    : benchmarkProvider.startsWith("sina")
      ? "新浪财经"
      : benchmarkProvider === "eastmoney"
        ? "东方财富"
        : "公开行情源";
  return {
    ...report,
    generatedAt: report?.generatedAt || new Date().toISOString(),
    source: `${poolProviderLabel} + ${historyProviderLabel}个股日线 + ${benchmarkProviderLabel}基准`,
    sourceClass: "public_web",
    universeSize: Number(context.universeSize || candidates.length || 0),
    availableUniverseSize: Number(
      context.availableUniverseSize || candidates.length || 0
    ),
    processed: Number(context.processed || 0),
    failed: Number(context.failed || 0),
    benchmarkBars: Number(context.benchmarkBars || 0),
    historyBarsRequested: Number(context.historyBarsRequested || 0),
    candidateCount: candidates.length,
    currentCandidateSize: Number(
      context.currentCandidateSize ?? candidates.length
    ),
    validationUniverseSize: Number(
      context.validationUniverseSize ?? context.processed ?? 0
    ),
    validationProcessed: Number(
      context.validationProcessed ?? context.validationUniverseSize ?? 0
    ),
    validationFailed: Number(context.validationFailed || 0),
    independentValidationSampleSize: Number(
      context.independentValidationSampleSize || 0
    ),
    independentValidationUsableSampleSize: Number(
      context.independentValidationUsableSampleSize || 0
    ),
    independentValidationBoardCounts:
      context.independentBoardCounts || {},
    independentValidationUsableBoardCounts:
      context.independentUsableBoardCounts || {},
    independentValidationUniverse:
      context.independentValidationUniverse === true,
    qualifiedCount: qualifiedCodes.size,
    matchedSignalCount: matchedCodes.size,
    optimizedPortfolio,
    publishedStrategyCount: publishedStrategies.length,
    baseStrategyCount: reportStrategies.filter(
      (strategy) => !isCompositeStrategy(strategy)
    ).length,
    compositeStrategyCount: reportStrategies.filter(isCompositeStrategy).length,
    publishedCompositeCount: publishedStrategies.filter(isCompositeStrategy).length,
    publishedBaseCount: publishedStrategies.filter(
      (strategy) => !isCompositeStrategy(strategy)
    ).length,
    auditedStrategyCount: auditedStrategies.length,
    rejectedStrategyCount: auditedStrategies.length - publishedStrategies.length,
    publicationPolicy:
      "每套策略按自己的规则在当前涨停候选池里直接选股；页面列出各策略本轮选出的股票、信号强度与命中依据。",
    compositePublicationPolicy:
      "组合策略与基础策略使用完全相同的选股规则；type、components 或 voteRule 不构成放宽条件。",
    universeDefinition: {
      signalUniverse:
        `最近11个交易日${poolProviderLabel}中的非ST股票，按新近度、连板数和成交额排序后截取本轮上限。`,
      validationUniverse:
        `对本轮信号候选证券请求${Number(context.historyBarsRequested || STRATEGY_SIGNAL_HISTORY_BARS)}根${historyProviderLabel}不复权日线，在最近约三年的历史区间内回放策略。`,
      benchmark:
        `中证全指（000985）${benchmarkProviderLabel}不复权日线`,
      independentValidationUniverse:
        context.independentValidationUniverse === true,
      independentValidationSampleSize: Number(
        context.independentValidationSampleSize || 0
      ),
      historicalPointInTimeConstituents: false
    },
    selectionBiasWarning: selectionBiasWarningV2,
    strategiesTested: reportStrategies.length,
    multipleTestingWarning:
      `本轮同时检验 ${reportStrategies.length} 套预定义策略；即使未做参数寻优，择优发布仍存在多重比较与过拟合风险，应以新增样本持续复核。`,
    sampleDiversity: buildStrategySampleDiversity(
      context.validationCandidates || candidates
    ),
    dataRange: context?.dataQuality?.dataRange || {
      from: "",
      to: ""
    },
    dataQuality: context.dataQuality || {},
    dataFailureReasons: Array.isArray(context.failureDetails)
      ? context.failureDetails
      : [],
    strategyAudit,
    auditedStrategies,
    methodology: methodology ||
      "信号日仅使用当日及以前数据；次一交易日开盘入场；固定持有期退出；扣除双边成本；时间切分样本外与走步复核。",
    methodologyDetails,
    warning: warnings.join(" "),
    coverage: {
      ...(report?.coverage || {}),
      universeSize: Number(context.universeSize || candidates.length || 0),
      currentCandidateSize: Number(
        context.currentCandidateSize ?? candidates.length
      ),
      validationUniverseSize: Number(
        context.validationUniverseSize ?? context.processed ?? 0
      ),
      independentValidationSampleSize: Number(
        context.independentValidationSampleSize || 0
      ),
      independentValidationUniverse:
        context.independentValidationUniverse === true,
      processed: Number(context.processed || 0),
      failed: Number(context.failed || 0),
      historyBarsRequested: Number(context.historyBarsRequested || 0),
      benchmarkBars: Number(context.benchmarkBars || 0)
    },
    strategies
  };
}

function strategyUsableHistoryRows(history) {
  const byDate = new Map();
  for (const row of Array.isArray(history) ? history : []) {
    const date = String(row?.date || "").slice(0, 10);
    const open = Number(row?.open);
    const high = Number(row?.high);
    const low = Number(row?.low);
    const close = Number(row?.close);
    if (
      !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(open) ||
      !Number.isFinite(high) ||
      !Number.isFinite(low) ||
      !Number.isFinite(close) ||
      open <= 0 ||
      high <= 0 ||
      low <= 0 ||
      close <= 0
    ) {
      continue;
    }
    byDate.set(date, row);
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([date, row]) => ({ ...row, date }));
}

function strategyMedian(values) {
  const numbers = values
    .map(Number)
    .filter(Number.isFinite)
    .sort((left, right) => left - right);
  if (!numbers.length) return null;
  const middle = Math.floor(numbers.length / 2);
  return numbers.length % 2
    ? numbers[middle]
    : (numbers[middle - 1] + numbers[middle]) / 2;
}

function buildStrategyDataQuality(
  candidates,
  historyResults,
  benchmarkResult,
  requestedBars
) {
  const securities = (Array.isArray(candidates) ? candidates : []).map(
    (candidate, index) => {
      const result = historyResults[index];
      if (!result?.ok) {
        return {
          code: String(candidate?.code || ""),
          name: String(candidate?.name || candidate?.code || ""),
          status: "failed",
          provider: "",
          requestedBars,
          receivedBars: 0,
          usableBars: 0,
          from: "",
          to: "",
          meets420Bars: false,
          meets720Bars: false,
          failureReason: String(result?.error || "历史行情获取失败").slice(0, 240)
        };
      }
      const rawRows = Array.isArray(result.value) ? result.value : [];
      const usableRows = rawRows.strategyPrepared
        ? rawRows
        : strategyUsableHistoryRows(rawRows);
      return {
        code: String(candidate?.code || ""),
        name: String(candidate?.name || candidate?.code || ""),
        status: "ok",
        provider: String(rawRows.dataSource || "unknown"),
        requestedBars,
        receivedBars: rawRows.length,
        usableBars: usableRows.length,
        invalidOrDuplicateBars: Math.max(0, rawRows.length - usableRows.length),
        from: String(usableRows[0]?.date || ""),
        to: String(usableRows.at(-1)?.date || ""),
        meets420Bars: usableRows.length >= 420,
        meets720Bars: usableRows.length >= 720,
        coverageRatio:
          requestedBars > 0
            ? Number(Math.min(1, usableRows.length / requestedBars).toFixed(4))
            : null,
        failureReason: ""
      };
    }
  );
  const successful = securities.filter(
    (item) => item.status === "ok" && item.usableBars > 0
  );
  const providers = successful.reduce((counts, item) => {
    const provider = String(item.provider || "unknown");
    counts[provider] = Number(counts[provider] || 0) + 1;
    return counts;
  }, {});
  const fromDates = successful.map((item) => item.from).filter(Boolean).sort();
  const toDates = successful.map((item) => item.to).filter(Boolean).sort();
  const commonFromDates = [...fromDates].sort().reverse();
  const commonToDates = [...toDates].sort();
  const benchmarkRows = benchmarkResult?.ok
    ? strategyUsableHistoryRows(benchmarkResult.value)
    : [];
  const eventDates = (Array.isArray(candidates) ? candidates : [])
    .map((item) => String(item?.limitDate || "").slice(0, 10))
    .filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();
  const failures = securities
    .filter((item) => item.status === "failed")
    .map((item) => ({
      code: item.code,
      name: item.name,
      stage: "stock_history",
      reason: item.failureReason
    }));
  if (!benchmarkResult?.ok) {
    failures.push({
      code: "000985",
      name: "中证全指",
      stage: "benchmark_history",
      reason: String(
        benchmarkResult?.error || "中证全指基准历史获取失败"
      ).slice(0, 240)
    });
  }
  return {
    requestedBars,
    minimumRequestedBars: STRATEGY_SIGNAL_HISTORY_BARS,
    minimumReplayEvidenceBars: 420,
    adjustment: "不复权",
    dataRange: {
      from: fromDates[0] || "",
      to: toDates.at(-1) || "",
      commonFrom: commonFromDates[0] || "",
      commonTo: commonToDates[0] || ""
    },
    candidateEventRange: {
      from: eventDates[0] || "",
      to: eventDates.at(-1) || "",
      tradingDays: 11
    },
    summary: {
      selectedSecurities: securities.length,
      usableSecurities: successful.length,
      failedSecurities: securities.length - successful.length,
      securitiesWith420Bars: successful.filter((item) => item.meets420Bars).length,
      securitiesWith720Bars: successful.filter((item) => item.meets720Bars).length,
      securitiesWithFullWindow: successful.filter(
        (item) => item.usableBars >= requestedBars
      ).length,
      minimumUsableBars: successful.length
        ? Math.min(...successful.map((item) => item.usableBars))
        : 0,
      medianUsableBars: strategyMedian(
        successful.map((item) => item.usableBars)
      ),
      maximumUsableBars: successful.length
        ? Math.max(...successful.map((item) => item.usableBars))
        : 0,
      providers
    },
    benchmark: {
      code: "000985",
      name: "中证全指",
      status: benchmarkResult?.ok ? "ok" : "failed",
      provider: String(benchmarkResult?.value?.dataSource || ""),
      requestedBars,
      receivedBars: Array.isArray(benchmarkResult?.value)
        ? benchmarkResult.value.length
        : 0,
      usableBars: benchmarkRows.length,
      from: String(benchmarkRows[0]?.date || ""),
      to: String(benchmarkRows.at(-1)?.date || ""),
      adjustment: "不复权",
      failureReason: benchmarkResult?.ok
        ? ""
        : String(benchmarkResult?.error || "基准历史获取失败").slice(0, 240)
    },
    securities,
    failures
  };
}

const STRATEGY_SKIP_REASONS = Object.freeze({ stale: "日线没有更新到最近交易日（可能停牌）", missing: "没读到日线", invalid: "日线数据有异常",
  excluded: "ST 或风险股票，策略选股不覆盖" });

// 引擎给出的具体原因（dataQuality.reasons）→ 给 AI 和用户看的说明；比按类别的笼统说法准确。
const STRATEGY_SKIP_DETAILS = Object.freeze({
  incomplete_sessions: "最近 120 个交易日的日线不全（上市不足 120 个交易日，或期间停牌），策略选股不计算这只股票",
  missing_as_of_session: "日线没有最近交易日这一根（可能停牌或数据未更新）",
  insufficient_listing_sessions: "上市不足 120 个交易日，策略选股不计算这只股票",
  unresolved_price_basis: "区间内有除权除息，未复权日线前后价格不可比，策略选股不计算这只股票",
  missing_history: "没读到日线", risk_security: "ST 或风险股票，策略选股不覆盖"
});

/**
 * AI 问股（1.6.53）：用「策略选股」同一套引擎和本地日线，只算一只股票命中了哪些在用策略。
 * 按最近一个完整交易日的收盘数据（盘中看的是上一交易日收盘后的信号），和策略选股页的结果一致。
 */
async function strategyHitsForStock(input, deps = {}) {
  const security = toSecurity(input);
  const calendar = deps.calendar || createTradingCalendar();
  const now = typeof deps.now === "function" ? deps.now() : new Date();
  const marketData = deps.marketData || strategySelectionMarketData;
  const signal = serviceSignal();
  const resolveCalendar = activeCalendar => {
    const expected = activeCalendar.expectedCloseDate(now);
    const marketDates = expected?.state === "known" && expected?.date
      ? activeCalendar.sessionsThrough(expected.date, SELECTION_MARKET_SESSIONS)
      : null;
    return { expected, marketDates };
  };
  let expected = null;
  let marketDates = null;
  let calendarError = null;
  try {
    ({ expected, marketDates } = resolveCalendar(calendar));
  } catch (error) {
    calendarError = error;
  }
  let benchmark = null;
  if (!marketDates && typeof calendar.withObservedSessions === "function") {
    let benchmarkError = null;
    try {
      benchmark = await serviceRuntime.track(() => trackServiceRequest(marketData.fetchBenchmark({ signal })));
    } catch (error) {
      serviceSignal()?.throwIfAborted();
      benchmarkError = error;
    }
    serviceSignal()?.throwIfAborted();
    if (benchmarkError) {
      const baseReason = calendarError?.message || expected?.reason || "交易日历未覆盖最近交易日，暂时无法计算策略信号";
      throw new Error(`${baseReason}；指数行情读取失败，无法推断交易日：${benchmarkError instanceof Error ? benchmarkError.message : String(benchmarkError)}`, { cause: benchmarkError });
    }
    const observedDates = (Array.isArray(benchmark) ? benchmark : [])
      .map(row => String(row?.date ?? ""))
      .filter(date => /^\d{4}-\d{2}-\d{2}$/.test(date));
    try {
      ({ expected, marketDates } = resolveCalendar(calendar.withObservedSessions(observedDates)));
    } catch (error) {
      calendarError = error;
      marketDates = null;
    }
  }
  if (!marketDates) throw new Error(calendarError?.message || expected?.reason || "交易日历未覆盖最近交易日，暂时无法计算策略信号");
  const [history, resolvedBenchmark] = await Promise.all([
    serviceRuntime.track(() => trackServiceRequest(marketData.fetchHistory(security, "none", { signal }))),
    benchmark !== null
      ? Promise.resolve(benchmark)
      : serviceRuntime.track(() => trackServiceRequest(marketData.fetchBenchmark({ signal }))).catch(() => [])
  ]);
  serviceSignal()?.throwIfAborted();
  const engine = require("../strategy-signal-engine.cjs");
  const report = engine.buildStrategySelectionReport([{ code: security.code, name: String(input?.name || security.code) }], { [security.code]: history?.rows || [] },
    Array.isArray(resolvedBenchmark) ? resolvedBenchmark : [], { selectionOnly: true, minCurrentHistoryBars: SELECTION_MARKET_SESSIONS, asOfDate: expected.date, marketDates,
      universe: "limit_pool", historicalReview: false });
  const quality = report?.dataQuality || {};
  const skipped = ["stale", "missing", "invalid", "excluded"].find(key => Number(quality[key]) > 0);
  const detail = Object.keys(quality.reasons || {}).map(reason => STRATEGY_SKIP_DETAILS[reason]).find(Boolean);
  const strategies = Array.isArray(report?.strategies) ? report.strategies.filter(item => !item.custom) : [];
  const hits = strategies.filter(item => item.stocks?.length).map(item => {
    const stock = item.stocks[0];
    return { id: item.id, name: item.name, featured: item.featured === true, family: item.family || "", signalDate: stock.signalDate || "",
      reasons: (stock.reasons || []).slice(0, 3), invalidationPrice: Number.isFinite(stock.invalidationPrice) ? stock.invalidationPrice : null,
      notes: (stock.executionNotes || []).slice(0, 3) };
  });
  return { asOfDate: expected.date, evaluated: Number(quality.processed) > 0, skippedReason: skipped ? detail || STRATEGY_SKIP_REASONS[skipped] : "",
    activeCount: strategies.length, featuredCount: strategies.filter(item => item.featured).length, hits };
}

function getStrategyDefinitions() {
  return strategyDefinitions().map((definition) => ({
    id: String(definition.id || ""),
    name: String(definition.name || definition.id || ""),
    type: definition.type === "composite" ? "composite" : "base",
    ...(definition.version ? {
      version: definition.version,
      sources: definition.sources,
      parameters: definition.parameters,
      adaptationNote: definition.adaptationNote,
      componentNames: definition.componentNames
    } : {}),
    family: definition.family, scope: definition.scope, dataRequirements: definition.dataRequirements, evidenceLevel: definition.evidenceLevel,
    featured: definition.featured === true,
    ...(definition.retired === true ? { retired: true } : {}),
    detail: String(definition.detail || ""),
    conditions: Array.isArray(definition.conditions)
      ? definition.conditions.map(String)
      : [],
    risk: String(definition.risk || ""),
    components: Array.isArray(definition.components)
      ? definition.components.map(String)
      : [],
    voteRule: String(definition.voteRule || "单策略逐日命中")
  }));
}

module.exports = {
  strategyValidationUniverseCache,
  STRATEGY_SIGNAL_HISTORY_BARS,
  STRATEGY_SIGNAL_VALIDATION_SAMPLE,
  marketFromCode,
  strategyBoardBucket,
  strategyValidationBoard,
  stableStrategySampleHash,
  selectIndependentValidationSample,
  SINA_MARKET_CENTER,
  SINA_BROAD_PAGE_SIZE,
  SINA_BROAD_MAX_PAGES,
  sinaBroadUniversePage,
  sinaBroadUniverseDeclaredTotal,
  broadAStockValidationUniverse,
  buildStrategySampleDiversity,
  strategySignalGrade,
  strategyValidationAliases,
  enrichStrategySignalReport,
  strategyUsableHistoryRows,
  strategyMedian,
  buildStrategyDataQuality,
  STRATEGY_SKIP_REASONS,
  STRATEGY_SKIP_DETAILS,
  strategyHitsForStock,
  getStrategyDefinitions
};
