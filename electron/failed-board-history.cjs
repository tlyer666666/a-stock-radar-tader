"use strict";

/**
 * Owns failed-board event normalization and snapshot assembly. Market calendars,
 * transport retrieval, and stock classification are injected by the service facade.
 */
function createFailedBoardHistoryService(dependencies) {
  const {
    displayDate,
    todayInShanghai,
    isAStockCode,
    isRiskStockName,
    recentLimitUpPools,
    recentTradingDates,
    selectLimitUpTradingDates,
    topicPoolForDate,
    // 可选：按代码补行业（同花顺涨停/炸板池不带行业字段）。返回 Map<code, 行业名>。
    resolveIndustries = null
  } = dependencies;

const industryText = (value) => {
  const text = String(value ?? "").trim();
  return text && text !== "未分类" && text !== "--" ? text : "";
};

function normalizedPoolCode(value = "") {
  const match = String(value || "").trim().match(/\d{6}/);
  return match?.[0] || "";
}

function sourcePoolItem(raw = {}) {
  if (raw?.dataProvider === "ths_public_limit_up" || raw?.dataProvider === "ths_public_open_limit") {
    return raw?.raw?.sourceItem && typeof raw.raw.sourceItem === "object"
      ? raw.raw.sourceItem
      : {};
  }
  return raw?.raw && typeof raw.raw === "object" ? raw.raw : {};
}

function nullablePoolMetric(item, normalizedKey, sourceKeys, allowDerived = false) {
  const source = sourcePoolItem(item);
  const sourceKey = sourceKeys.find((key) => Object.prototype.hasOwnProperty.call(source, key));
  if (sourceKey) {
    const sourceValue = source[sourceKey];
    if (sourceValue === null || sourceValue === undefined || sourceValue === "") return null;
    const normalizedValue = item?.[normalizedKey];
    if (normalizedValue === null || normalizedValue === undefined || normalizedValue === "") return null;
    const value = Number(normalizedValue);
    return Number.isFinite(value) ? value : null;
  }
  if (item?.raw && typeof item.raw === "object" && !allowDerived) return null;
  if (item?.[normalizedKey] === null || item?.[normalizedKey] === undefined || item?.[normalizedKey] === "") return null;
  const value = Number(item[normalizedKey]);
  return Number.isFinite(value) ? value : null;
}

function nullablePoolTime(item, normalizedKey, sourceKeys) {
  const source = sourcePoolItem(item);
  const sourceKey = sourceKeys.find((key) => Object.prototype.hasOwnProperty.call(source, key));
  if (sourceKey) {
    const rawValue = source[sourceKey];
    if (rawValue === null || rawValue === undefined || rawValue === "" || Number(rawValue) === 0) return null;
  } else if (item?.raw && typeof item.raw === "object") {
    return null;
  }
  const value = String(item?.[normalizedKey] || "").trim();
  return value && value !== "--" ? value : null;
}

function nullablePoolString(item, normalizedKey, sourceKeys) {
  const source = sourcePoolItem(item);
  const sourceKey = sourceKeys.find((key) => Object.prototype.hasOwnProperty.call(source, key));
  if (sourceKey) {
    const value = String(source[sourceKey] ?? "").trim();
    return value || null;
  }
  if (item?.raw && typeof item.raw === "object") return null;
  const value = String(item?.[normalizedKey] ?? "").trim();
  return value || null;
}

function poolSnapshotSource(pool, requestedDate) {
  const providers = Array.isArray(pool?.providers)
    ? pool.providers.filter(Boolean)
    : pool?.provider ? [pool.provider] : [];
  return {
    providers,
    requestedDate: requestedDate || pool?.date || null,
    sourceTradingDate: pool?.serverTradingDate || null,
    sourceLatestDate: pool?.serverTradingDate || null,
    fetchedAt: pool?.fetchedAt || null
  };
}

function failedMetrics(item) {
  const hasFuyaoCount = item?.openBoardCountProvider === "fuyao_limit_break_pool" &&
    Number.isInteger(item.openBoardCount) && item.openBoardCount > 0;
  const isThs = item?.dataProvider === "ths_public_open_limit";
  return {
    latest: nullablePoolMetric(item, "latest", ["latest", "p"]),
    changePct: nullablePoolMetric(item, "changePct", ["change_rate", "zdp", "changePct"]),
    amount: nullablePoolMetric(item, "amount", isThs ? ["amount", "turnover"] : ["amount"]),
    turnover: nullablePoolMetric(item, "turnover", ["turnover_rate", "hs", "turnoverPct", ...(!isThs ? ["turnover"] : [])]),
    firstSealTime: nullablePoolTime(item, "firstSealTime", ["first_limit_up_time", "fbt", "firstSealTime"]),
    lastSealTime: nullablePoolTime(item, "lastSealTime", ["last_limit_up_time", "lbt", "lastSealTime"]),
    openBoardCount: hasFuyaoCount ? item.openBoardCount : nullablePoolMetric(item, "openBoardCount", ["open_board_count", "zbc", "openBoardCount"])
  };
}

function failedBoardDaySnapshot(date, pool, error, confirmedDates = new Set()) {
  const requestedDate = displayDate(date);
  if (error) {
    return {
      date: requestedDate,
      status: "unavailable",
      rows: [],
      source: null,
      error: error instanceof Error ? error.message : String(error)
    };
  }

  const sourceLatestDate = displayDate(pool?.serverTradingDate || "") || null;
  const source = pool ? {
    providers: Array.isArray(pool.providers)
      ? pool.providers.filter(Boolean)
      : pool.provider ? [pool.provider] : [],
    requestedDate,
    sourceLatestDate,
    dateConfirmationProvider: pool.dateConfirmationProvider || null,
    fetchedAt: pool.fetchedAt || null
  } : null;
  const dateConfirmed = confirmedDates.has(requestedDate);
  const sourceConfirmsRequest = Boolean(
    pool &&
    pool.date === requestedDate &&
    Array.isArray(pool.pool) &&
    sourceLatestDate &&
    sourceLatestDate >= requestedDate &&
    dateConfirmed &&
    (requestedDate !== displayDate(todayInShanghai()) || sourceLatestDate === requestedDate)
  );

  if (!sourceConfirmsRequest) {
    return {
      date: requestedDate,
      status: "awaiting-confirmation",
      rows: [],
      source,
      error: "炸板池数据日期尚未确认"
    };
  }

  const seen = new Set();
  const rows = [];
  for (const item of pool.pool) {
    const code = normalizedPoolCode(item?.code);
    const name = String(item?.name || code);
    if (!code || seen.has(code) || !isAStockCode(code) || isRiskStockName(name)) continue;
    seen.add(code);
    rows.push({
      code,
      name,
      industry: String(item?.industry || "未分类"),
      consecutiveBoards: nullablePoolMetric(item, "consecutiveBoards", ["high_days", "lbc", "consecutiveBoards"], false),
      ...failedMetrics(item)
    });
  }
  return { date: requestedDate, status: "ready", rows, source, error: null };
}

function previousLimitIntersectionRows(previousPool, failedPool) {
  const previousByCode = new Map();
  for (const item of previousPool || []) {
    const code = normalizedPoolCode(item?.code);
    const name = String(item?.name || code);
    if (!code || !isAStockCode(code) || isRiskStockName(name) || previousByCode.has(code)) continue;
    previousByCode.set(code, item);
  }

  const seen = new Set();
  const rows = [];
  for (const todayItem of failedPool || []) {
    const code = normalizedPoolCode(todayItem?.code);
    if (!code || seen.has(code) || !previousByCode.has(code)) continue;
    const previousItem = previousByCode.get(code);
    const name = String(todayItem?.name || previousItem?.name || code);
    if (!isAStockCode(code) || isRiskStockName(name)) continue;
    seen.add(code);
    const boardType = nullablePoolString(previousItem, "boardType", ["limit_up_type", "boardType"]);
    rows.push({
      code,
      name,
      industry: industryText(todayItem?.industry) || industryText(previousItem?.industry) || "未分类",
      previous: {
        consecutiveBoards: nullablePoolMetric(previousItem, "consecutiveBoards", ["high_days", "lbc", "consecutiveBoards"], true),
        firstSealTime: nullablePoolTime(previousItem, "firstSealTime", ["first_limit_up_time", "fbt", "firstSealTime"]),
        lastSealTime: nullablePoolTime(previousItem, "lastSealTime", ["last_limit_up_time", "lbt", "lastSealTime"]),
        openBoardCount: nullablePoolMetric(previousItem, "openBoardCount", ["open_board_count", "zbc", "openBoardCount"]),
        boardType,
        isOneWordBoard: boardType === null ? null : /一字/.test(boardType)
      },
      today: failedMetrics(todayItem)
    });
  }
  return rows;
}

async function getPreviousLimitUpFailedBoardSnapshot(options = {}) {
  const errors = { previousLimitUp: null, todayFailed: null };
  let pools = [];
  try {
    pools = await recentLimitUpPools(2, options);
  } catch (error) {
    errors.previousLimitUp = error instanceof Error ? error.message : String(error);
  }

  const current = pools?.[0] || null;
  let benchmarkDates = [];
  try {
    benchmarkDates = await recentTradingDates(12);
  } catch (error) {
    if (!errors.previousLimitUp) errors.previousLimitUp = error instanceof Error ? error.message : String(error);
  }

  const today = todayInShanghai();
  let dateConfirmationPool = current;
  if (displayDate(current?.date || "") !== displayDate(today) || displayDate(current?.serverTradingDate || "") !== displayDate(today)) {
    try {
      const eastmoneyConfirmation = await topicPoolForDate(today, "limit", {
        provider: "eastmoney",
        fallbackEnabled: false,
        forceRefresh: false
      });
      if (eastmoneyConfirmation.serverTradingDate === displayDate(today)) {
        dateConfirmationPool = eastmoneyConfirmation;
      }
    } catch {
      // The date still comes from the recent benchmark calendar below.
    }
  }

  const selectedDates = selectLimitUpTradingDates(today, dateConfirmationPool, benchmarkDates, 5);
  const confirmedDates = new Set(benchmarkDates.map(displayDate));
  if (dateConfirmationPool && displayDate(dateConfirmationPool.date) === displayDate(today) && displayDate(dateConfirmationPool.serverTradingDate || "") === displayDate(today)) {
    confirmedDates.add(displayDate(dateConfirmationPool.date));
  }
  const requestedRefreshDate = displayDate(options.refreshDate || "");
  const refreshDate = selectedDates.find(date => displayDate(date) === requestedRefreshDate) || selectedDates[0];
  const dayResults = await Promise.all(selectedDates.map(async (date) => {
    try {
      let pool = await topicPoolForDate(date, "failed", {
        ...options,
        forceRefresh: options.forceRefresh === true && date === refreshDate
      });
      // A null payload has no market date of its own. Only independent source
      // evidence plus the benchmark trading calendar can confirm a zero day.
      if (pool?.dataAbsent && confirmedDates.has(displayDate(date))) {
        const proofDate = displayDate(dateConfirmationPool?.serverTradingDate || "");
        if (proofDate && proofDate >= displayDate(date) && (displayDate(date) !== displayDate(today) || proofDate === displayDate(today))) {
          pool = { ...pool, serverTradingDate: proofDate, dateConfirmed: true, dateConfirmationProvider: dateConfirmationPool.provider };
        }
      }
      return { date, pool, snapshot: failedBoardDaySnapshot(date, pool, null, confirmedDates) };
    } catch (error) {
      return { date, pool: null, snapshot: failedBoardDaySnapshot(date, null, error, confirmedDates) };
    }
  }));
  const failedBoardDays = dayResults.map((result) => result.snapshot);
  const currentDate = failedBoardDays[0]?.date || null;
  const previousDate = failedBoardDays[1]?.date || null;
  const previous = previousDate ? pools.find(pool => displayDate(pool?.date || "") === previousDate) : null;
  const failedByDate = new Map(dayResults.map((result) => [displayDate(result.date), result.pool]));
  const currentFailedDay = failedBoardDays.find((day) => day.date === currentDate) || null;
  const currentFailedPool = failedByDate.get(currentDate || "") || null;
  const hasPreviousPool = Boolean(previous && Array.isArray(previous.pool) && previousDate && previousDate !== currentDate);
  const intersectionReady = Boolean(hasPreviousPool && currentFailedDay?.status === "ready" && Array.isArray(currentFailedPool?.pool));

  const rows = intersectionReady ? previousLimitIntersectionRows(previous.pool, currentFailedPool.pool) : [];
  await fillIndustries([rows, ...failedBoardDays.map(day => day.rows)], [currentDate, previousDate, ...failedBoardDays.map(day => day.date)].filter(Boolean), options);

  return {
    status: intersectionReady ? "ready" : currentFailedDay?.status === "unavailable" || !failedBoardDays.length
      ? "unavailable"
      : "awaiting-confirmation",
    previousDate,
    currentDate,
    rows,
    failedBoardDays,
    sources: {
      previousLimitUp: previous ? poolSnapshotSource(previous, previousDate) : null,
      todayFailed: currentFailedDay?.source ? {
        providers: currentFailedDay.source.providers,
        requestedDate: currentFailedDay.source.requestedDate,
        sourceTradingDate: currentFailedDay.source.sourceLatestDate,
        fetchedAt: currentFailedDay.source.fetchedAt
      } : null
    },
    errors: {
      previousLimitUp: errors.previousLimitUp || (!hasPreviousPool ? "最近两个涨停交易日尚未确认" : null),
      todayFailed: currentFailedDay?.error || null
    },
    checkedAt: new Date().toISOString(),
    isPreview: false
  };
}

/** 行业缺失的股票按代码补齐；补不到的保留“未分类”。补充失败不影响炸板观察本身。 */
async function fillIndustries(rowGroups, dates, options) {
  if (typeof resolveIndustries !== "function") return;
  const missing = new Set();
  for (const group of rowGroups) for (const row of Array.isArray(group) ? group : []) {
    if (row?.code && !industryText(row.industry)) missing.add(row.code);
  }
  if (!missing.size) return;
  let found;
  try { found = await resolveIndustries([...missing], { dates: [...new Set(dates)], signal: options?.signal }); }
  catch { return; }
  if (!(found instanceof Map) || !found.size) return;
  for (const group of rowGroups) for (const row of Array.isArray(group) ? group : []) {
    const industry = industryText(found.get(row?.code));
    if (row && !industryText(row.industry) && industry) row.industry = industry;
  }
}

  return { getPreviousLimitUpFailedBoardSnapshot };
}

module.exports = { createFailedBoardHistoryService };
