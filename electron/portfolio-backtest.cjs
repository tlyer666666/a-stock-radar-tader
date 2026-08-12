"use strict";

const DEFAULT_ANNUAL_TRADING_DAYS = 252;

function finite(value) {
  return Number.isFinite(Number(value));
}

function round(value, digits = 4) {
  if (value === null || value === undefined || value === "") return null;
  if (!Number.isFinite(Number(value))) return null;
  const scale = 10 ** digits;
  return Math.round(Number(value) * scale) / scale;
}

function average(values) {
  const usable = values.filter(Number.isFinite);
  return usable.length
    ? usable.reduce((sum, value) => sum + value, 0) / usable.length
    : null;
}

function standardDeviation(values) {
  const usable = values.filter(Number.isFinite);
  if (usable.length < 2) return null;
  const mean = average(usable);
  const variance = usable.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0
  ) / (usable.length - 1);
  return Math.sqrt(variance);
}

function isIsoDate(value) {
  const text = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = new Date(`${text}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === text;
}

function historyEntries(historiesByCode) {
  if (historiesByCode instanceof Map) return [...historiesByCode.entries()];
  if (!historiesByCode || typeof historiesByCode !== "object") return [];
  return Object.entries(historiesByCode);
}

function normalizeCode(value) {
  return String(value || "").match(/\d{6}/)?.[0] || "";
}

function normalizeHistory(code, rawRows) {
  if (!Array.isArray(rawRows) || !rawRows.length) {
    throw new TypeError(`股票 ${code} 缺少历史行情`);
  }
  const rows = rawRows.map((raw, index) => {
    const date = String(raw?.date || raw?.tradeDate || "").slice(0, 10);
    const open = Number(raw?.open);
    const close = Number(raw?.close);
    if (!isIsoDate(date)) {
      throw new TypeError(`股票 ${code} 历史行情第 ${index + 1} 行日期无效`);
    }
    if (!(open > 0) || !(close > 0)) {
      throw new TypeError(`股票 ${code} ${date} 的开盘价或收盘价无效`);
    }
    return { date, open, close };
  }).sort((left, right) => left.date.localeCompare(right.date));
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].date === rows[index - 1].date) {
      throw new TypeError(`股票 ${code} 历史行情存在重复日期 ${rows[index].date}`);
    }
  }
  const byDate = new Map(rows.map((row, index) => [row.date, { ...row, index }]));
  return { code, rows, byDate };
}

function normalizeHistories(historiesByCode) {
  const histories = new Map();
  for (const [rawCode, rawRows] of historyEntries(historiesByCode)) {
    const code = normalizeCode(rawCode);
    if (!code) continue;
    histories.set(code, normalizeHistory(code, rawRows));
  }
  return histories;
}

function normalizeSample(raw, index, histories, nextMarketDate) {
  const code = normalizeCode(raw?.code);
  if (!code) throw new TypeError(`samples[${index}] 缺少6位股票代码`);
  const history = histories.get(code);
  if (!history) throw new TypeError(`samples[${index}] 的股票 ${code} 缺少历史行情`);
  const signalDate = String(raw?.signalDate || raw?.date || "").slice(0, 10);
  const entryDate = String(raw?.entryDate || "").slice(0, 10);
  const exitDate = String(raw?.exitDate || "").slice(0, 10);
  if (!isIsoDate(signalDate) || !isIsoDate(entryDate) || !isIsoDate(exitDate)) {
    throw new TypeError(`samples[${index}] 的 signalDate/entryDate/exitDate 无效`);
  }
  const signalRow = history.byDate.get(signalDate);
  const entryRow = history.byDate.get(entryDate);
  const exitRow = history.byDate.get(exitDate);
  if (!signalRow) {
    throw new TypeError(`samples[${index}] 的信号日 ${signalDate} 不在 ${code} 历史行情中`);
  }
  if (!entryRow) {
    throw new TypeError(`samples[${index}] 的入场日 ${entryDate} 不在 ${code} 历史行情中`);
  }
  if (!exitRow) {
    throw new TypeError(`samples[${index}] 的退出日 ${exitDate} 不在 ${code} 历史行情中`);
  }
  const expectedEntry = history.rows[signalRow.index + 1]?.date || "";
  if (entryDate !== expectedEntry) {
    throw new TypeError(
      `samples[${index}] 的入场日必须是信号日后的首个交易日（应为 ${expectedEntry || "无可用交易日"}）`
    );
  }
  if (exitRow.index <= entryRow.index) {
    throw new TypeError(`samples[${index}] 的退出日必须晚于入场日`);
  }
  const netReturn = Number(raw?.netReturn);
  if (!Number.isFinite(netReturn) || netReturn < -100) {
    throw new TypeError(`samples[${index}] 缺少有效 netReturn（百分比）`);
  }
  const strategyId = String(raw?.strategyId || "selected_strategy");
  const sampleId = String(
    raw?.sampleId || raw?.id ||
    `${strategyId}:${code}:${signalDate}:${entryDate}:${exitDate}`
  );
  const priority = [raw?.priority, raw?.signalStrength, raw?.score]
    .filter((value) => value !== null && value !== undefined && value !== "")
    .map(Number)
    .find(Number.isFinite) ?? 0;
  const strategyIds = Array.isArray(raw?.strategyIds)
    ? [...new Set(raw.strategyIds.map(String).filter(Boolean))].sort()
    : [strategyId];
  return {
    sampleId,
    code,
    name: String(raw?.name || code),
    strategyId,
    strategyIds,
    signalDate,
    entryDate,
    exitDate,
    entryPrice: entryRow.open,
    exitPrice: exitRow.close,
    historicalGrossReturn: ((exitRow.close / entryRow.open) - 1) * 100,
    netReturn,
    priority,
    holdingTradingDays: exitRow.index - entryRow.index + 1,
    expectedMarketEntryDate: nextMarketDate.get(signalDate) || "",
    duplicateKey: `${code}:${signalDate}:${entryDate}:${exitDate}`
  };
}

function normalizeBenchmarkRows(rawRows) {
  if (!Array.isArray(rawRows)) {
    throw new TypeError("benchmarkHistory 必须是数组");
  }
  const rows = rawRows.map((raw, index) => {
    const date = String(raw?.date || raw?.tradeDate || "").slice(0, 10);
    const open = Number(raw?.open);
    const close = Number(raw?.close);
    if (!isIsoDate(date) || !(open > 0) || !(close > 0)) {
      throw new TypeError(`benchmarkHistory[${index}] 的日期或价格无效`);
    }
    return { date, open, close };
  }).sort((left, right) => left.date.localeCompare(right.date));
  for (let index = 1; index < rows.length; index += 1) {
    if (rows[index].date === rows[index - 1].date) {
      throw new TypeError(`benchmarkHistory 存在重复日期 ${rows[index].date}`);
    }
  }
  return rows;
}

function compareSignals(left, right) {
  return (
    left.entryDate.localeCompare(right.entryDate) ||
    right.priority - left.priority ||
    left.strategyId.localeCompare(right.strategyId) ||
    left.code.localeCompare(right.code) ||
    left.signalDate.localeCompare(right.signalDate) ||
    left.exitDate.localeCompare(right.exitDate) ||
    left.sampleId.localeCompare(right.sampleId)
  );
}

function rejectionFor(sample, reason, reasonText, state = {}) {
  return {
    sampleId: sample.sampleId,
    code: sample.code,
    name: sample.name,
    strategyId: sample.strategyId,
    strategyIds: [...(sample.strategyIds || [sample.strategyId])],
    signalDate: sample.signalDate,
    entryDate: sample.entryDate,
    exitDate: sample.exitDate,
    reason,
    reasonText,
    activePositions: Number(state.activePositions || 0),
    availableCash: round(Number(state.availableCash || 0), 2)
  };
}

function benchmarkReturn(rows, from, to) {
  if (!rows.length) return null;
  const start = rows.find((row) => row.date >= from);
  const end = [...rows].reverse().find((row) => row.date <= to);
  if (!start || !end || end.date < start.date) return null;
  return ((end.close / start.open) - 1) * 100;
}

/**
 * Simulate one shared cash account for multi-stock strategy samples.
 *
 * Timeline on each trading day is deliberately strict:
 * 1. At the open, new signals may use only cash and position slots released
 *    before that day. Positions scheduled to exit today still occupy a slot.
 * 2. At the close, fixed-exit samples settle using their caller-provided
 *    netReturn. Those proceeds become available only on the next trading day.
 * 3. Remaining positions are marked to that day's historical close.
 */
function simulateStrategyPortfolio(
  samples,
  historiesByCode,
  benchmarkHistory = [],
  options = {}
) {
  if (!Array.isArray(samples)) throw new TypeError("samples 必须是数组");
  const startingCapital = Number(options?.startingCapital ?? 200000);
  const maxPositions = Number(options?.maxPositions ?? 5);
  const annualTradingDays = Number(
    options?.annualTradingDays ?? DEFAULT_ANNUAL_TRADING_DAYS
  );
  const annualRiskFreeRatePercent = Number(options?.annualRiskFreeRatePercent || 0);
  const lotSize = Number(options?.lotSize ?? 100);
  const maxPositionPercent = Number(options?.maxPositionPercent ?? 100);
  if (!(startingCapital > 0)) throw new TypeError("startingCapital 必须大于0");
  if (!Number.isInteger(maxPositions) || maxPositions < 1 || maxPositions > 100) {
    throw new TypeError("maxPositions 必须是1至100之间的整数");
  }
  if (!(annualTradingDays > 0) || !Number.isFinite(annualRiskFreeRatePercent)) {
    throw new TypeError("年化参数无效");
  }
  if (!Number.isInteger(lotSize) || lotSize < 1 || lotSize > 10000) {
    throw new TypeError("lotSize 必须是1至10000之间的整数");
  }
  if (!(maxPositionPercent > 0) || maxPositionPercent > 100) {
    throw new TypeError("maxPositionPercent 必须大于0且不超过100");
  }

  const histories = normalizeHistories(historiesByCode);
  const benchmarkRows = normalizeBenchmarkRows(benchmarkHistory);
  const fallbackCalendar = [...new Set(
    [...histories.values()].flatMap((history) =>
      history.rows.map((row) => row.date)
    )
  )].sort();
  const masterCalendar = benchmarkRows.length
    ? benchmarkRows.map((row) => row.date)
    : fallbackCalendar;
  const requestedFrom = options?.rangeFrom
    ? String(options.rangeFrom).slice(0, 10)
    : masterCalendar[0] || "";
  const requestedTo = options?.rangeTo
    ? String(options.rangeTo).slice(0, 10)
    : masterCalendar.at(-1) || "";
  if (
    (requestedFrom && !isIsoDate(requestedFrom)) ||
    (requestedTo && !isIsoDate(requestedTo)) ||
    (requestedFrom && requestedTo && requestedFrom > requestedTo)
  ) {
    throw new TypeError("rangeFrom/rangeTo 无效");
  }
  const fullCalendar = masterCalendar.filter(
    (date) =>
      (!requestedFrom || date >= requestedFrom) &&
      (!requestedTo || date <= requestedTo)
  );
  if (!samples.length) {
    const securityCount = histories.size;
    const emptyBenchmarkReturn = fullCalendar.length
      ? benchmarkReturn(benchmarkRows, fullCalendar[0], fullCalendar.at(-1))
      : null;
    const equityCurve = fullCalendar.map((date) => ({
      date,
      equity: round(startingCapital, 2),
      cash: round(startingCapital, 2),
      marketValue: 0,
      openPositions: 0,
      openedToday: 0,
      closedToday: 0,
      rejectedToday: 0,
      dailyReturnPercent: 0,
      drawdownPercent: 0
    }));
    const metrics = {
      startingCapital: round(startingCapital, 2),
      endingCapital: round(startingCapital, 2),
      totalReturnPercent: 0,
      annualizedReturnPercent: 0,
      maxDrawdownPercent: 0,
      sharpe: null,
      sharpeRatio: null,
      winRatePercent: null,
      winRate: null,
      profitLossRatio: null,
      profitFactor: null,
      averageTradeReturnPercent: null,
      tradeCount: 0,
      winningTrades: 0,
      losingTrades: 0,
      rejectedSignalCount: 0,
      capacityRejected: 0,
      overlapRejected: 0,
      duplicateRejected: 0,
      missingNextMarketDayRejected: 0,
      insufficientLotRejected: 0,
      maxPositionsObserved: 0,
      securityCount,
      tradingDays: equityCurve.length,
      benchmarkReturnPercent: round(emptyBenchmarkReturn, 4),
      excessReturnPercent: emptyBenchmarkReturn === null
        ? null
        : round(-emptyBenchmarkReturn, 4)
    };
    return {
      id: "shared_strategy_portfolio",
      name: "多股票统一策略组合",
      status: "DIAGNOSTIC",
      validation: {
        accepted: false,
        status: "DIAGNOSTIC",
        reasons: [
          "所选股票与策略在回放区间内没有可成交信号，账户保持全现金。",
          securityCount < 30
            ? `股票篮子仅 ${securityCount} 只，少于30只，不能标记为已验证组合。`
            : ""
        ].filter(Boolean)
      },
      range: {
        from: fullCalendar[0] || requestedFrom,
        to: fullCalendar.at(-1) || requestedTo
      },
      settings: {
        startingCapital: round(startingCapital, 2),
        maxPositions,
        lotSize,
        maxPositionPercent,
        rangeFrom: fullCalendar[0] || requestedFrom,
        rangeTo: fullCalendar.at(-1) || requestedTo,
        annualTradingDays,
        annualRiskFreeRatePercent
      },
      methodology: {
        signalTiming: "信号只决定次一市场交易日开盘候选，不使用其后的行情排序",
        entry: "信号日后的首个市场交易日开盘入场；停牌或缺失该日K线则拒绝",
        sizing: "按开盘前现金/空闲席位与单股仓位上限孰低确定目标金额，再向下取A股整手；当日退出持仓仍占用席位",
        exit: "固定退出日收盘按样本 netReturn 结算",
        exitPrecision: "exitDate 沿用上游样本口径；未把个股第N根K线宣称为精确的第N个市场交易日",
        markToMarket: "未退出持仓按当日历史收盘价盯市，停牌日沿用最近收盘价",
        eventOrder: "开盘处理新入场，收盘处理退出；当日退出所得次日才可再用",
        calendar: benchmarkRows.length
          ? "使用 benchmarkHistory 作为主市场交易日历"
          : "未提供基准时使用个股交易日并集（诊断降级）"
      },
      metrics,
      equityCurve,
      contributions: [],
      trades: [],
      rejections: []
    };
  }
  if (!masterCalendar.length || !fullCalendar.length) {
    throw new TypeError("缺少可用的市场交易日历或请求区间无交易日");
  }
  const nextMarketDate = new Map(
    masterCalendar.map((date, index) => [date, masterCalendar[index + 1] || ""])
  );
  const ordered = samples
    .map((sample, index) => normalizeSample(sample, index, histories, nextMarketDate))
    .sort(compareSignals);
  const duplicateKeys = new Set();
  for (const sample of ordered) {
    sample.duplicate = duplicateKeys.has(sample.duplicateKey);
    duplicateKeys.add(sample.duplicateKey);
  }

  const entryGroups = new Map();
  for (const sample of ordered) {
    const rows = entryGroups.get(sample.entryDate) || [];
    rows.push(sample);
    entryGroups.set(sample.entryDate, rows);
  }
  const firstDate = fullCalendar[0];
  const lastDate = fullCalendar.at(-1);
  const outsideRange = ordered.find(
    (sample) => sample.entryDate < firstDate || sample.exitDate > lastDate
  );
  if (outsideRange) {
    throw new TypeError(
      `样本 ${outsideRange.sampleId} 的持有区间超出组合回测窗口 ${firstDate} 至 ${lastDate}`
    );
  }
  const calendar = fullCalendar;

  let cash = startingCapital;
  let previousEquity = startingCapital;
  let peakEquity = startingCapital;
  let maximumDrawdown = 0;
  let maxPositionsObserved = 0;
  const active = new Map();
  const equityCurve = [];
  const trades = [];
  const rejections = [];

  for (const date of calendar) {
    const candidates = (entryGroups.get(date) || []).sort(compareSignals);
    const freeSlotsAtOpen = maxPositions - active.size;
    const allocationPerFreeSlot = freeSlotsAtOpen > 0
      ? Math.min(
        cash / freeSlotsAtOpen,
        previousEquity * maxPositionPercent / 100
      )
      : 0;
    let openedToday = 0;
    for (const sample of candidates) {
      const state = { activePositions: active.size, availableCash: cash };
      if (
        !sample.expectedMarketEntryDate ||
        sample.entryDate !== sample.expectedMarketEntryDate
      ) {
        rejections.push(rejectionFor(
          sample,
          "missingNextMarketDay",
          `股票在信号后的下一市场交易日 ${sample.expectedMarketEntryDate || "--"} 无法按样本入场，按停牌或缺失行情拒绝`,
          state
        ));
        continue;
      }
      if (sample.duplicate) {
        rejections.push(rejectionFor(
          sample,
          "duplicate_signal",
          "同一股票、信号日与持有区间的重复信号已合并",
          state
        ));
        continue;
      }
      if (active.has(sample.code)) {
        rejections.push(rejectionFor(
          sample,
          "same_stock_overlap",
          `股票 ${sample.code} 已有尚未收盘退出的持仓`,
          state
        ));
        continue;
      }
      if (active.size >= maxPositions) {
        rejections.push(rejectionFor(
          sample,
          "capacity_limit",
          `持仓席位已满（${maxPositions}/${maxPositions}）`,
          state
        ));
        continue;
      }
      if (!(allocationPerFreeSlot > 0)) {
        rejections.push(rejectionFor(
          sample,
          "insufficient_cash",
          "开盘前可用现金不足",
          state
        ));
        continue;
      }
      const shares = Math.floor(
        allocationPerFreeSlot / sample.entryPrice / lotSize
      ) * lotSize;
      if (shares < lotSize) {
        rejections.push(rejectionFor(
          sample,
          "insufficient_lot",
          `目标仓位不足买入一手（${lotSize}股）`,
          state
        ));
        continue;
      }
      const allocation = shares * sample.entryPrice;
      if (cash + 1e-8 < allocation) {
        rejections.push(rejectionFor(
          sample,
          "insufficient_cash",
          "开盘前可用现金不足",
          state
        ));
        continue;
      }
      cash -= allocation;
      active.set(sample.code, {
        ...sample,
        allocation,
        shares,
        lastMarkPrice: sample.entryPrice
      });
      openedToday += 1;
      maxPositionsObserved = Math.max(maxPositionsObserved, active.size);
    }

    const closing = [...active.values()]
      .filter((position) => position.exitDate === date)
      .sort((left, right) =>
        left.code.localeCompare(right.code) || left.sampleId.localeCompare(right.sampleId)
      );
    for (const position of closing) {
      const pnl = position.allocation * position.netReturn / 100;
      const proceeds = position.allocation + pnl;
      cash += proceeds;
      active.delete(position.code);
      trades.push({
        sampleId: position.sampleId,
        code: position.code,
        name: position.name,
        strategyId: position.strategyId,
        strategyIds: [...position.strategyIds],
        signalDate: position.signalDate,
        entryDate: position.entryDate,
        exitDate: position.exitDate,
        holdingTradingDays: position.holdingTradingDays,
        entryPrice: round(position.entryPrice, 4),
        exitPrice: round(position.exitPrice, 4),
        allocation: round(position.allocation, 2),
        shares: round(position.shares, 6),
        historicalGrossReturnPercent: round(position.historicalGrossReturn, 4),
        netReturnPercent: round(position.netReturn, 4),
        pnl: round(pnl, 2),
        proceeds: round(proceeds, 2)
      });
    }

    let marketValue = 0;
    for (const position of active.values()) {
      const row = histories.get(position.code)?.byDate.get(date);
      if (row?.close > 0) position.lastMarkPrice = row.close;
      marketValue += position.shares * position.lastMarkPrice;
    }
    const equity = cash + marketValue;
    peakEquity = Math.max(peakEquity, equity);
    const drawdownPercent = peakEquity > 0
      ? ((equity / peakEquity) - 1) * 100
      : -100;
    maximumDrawdown = Math.min(maximumDrawdown, drawdownPercent);
    const dailyReturnPercent = previousEquity > 0
      ? ((equity / previousEquity) - 1) * 100
      : 0;
    equityCurve.push({
      date,
      equity: round(equity, 2),
      cash: round(cash, 2),
      marketValue: round(marketValue, 2),
      openPositions: active.size,
      openedToday,
      closedToday: closing.length,
      rejectedToday: candidates.length - openedToday,
      dailyReturnPercent: round(dailyReturnPercent, 4),
      drawdownPercent: round(drawdownPercent, 4)
    });
    previousEquity = equity;
  }

  if (active.size) {
    throw new Error("组合回测结束时仍有未结算持仓，请检查退出日期");
  }
  trades.sort((left, right) =>
    left.entryDate.localeCompare(right.entryDate) ||
    left.code.localeCompare(right.code) ||
    left.sampleId.localeCompare(right.sampleId)
  );
  rejections.sort((left, right) =>
    left.entryDate.localeCompare(right.entryDate) ||
    left.code.localeCompare(right.code) ||
    left.sampleId.localeCompare(right.sampleId)
  );

  const endingCapital = cash;
  const totalReturnPercent = ((endingCapital / startingCapital) - 1) * 100;
  const tradingDays = equityCurve.length;
  const annualizedReturnPercent = endingCapital > 0 && tradingDays > 0
    ? ((endingCapital / startingCapital) ** (annualTradingDays / tradingDays) - 1) * 100
    : -100;
  const dailyReturns = equityCurve.map((point) => Number(point.dailyReturnPercent) / 100);
  const dailyAverage = average(dailyReturns);
  const dailyVolatility = standardDeviation(dailyReturns);
  const dailyRiskFree = annualRiskFreeRatePercent / 100 / annualTradingDays;
  const sharpe = dailyVolatility && dailyVolatility > 0
    ? ((dailyAverage - dailyRiskFree) / dailyVolatility) * Math.sqrt(annualTradingDays)
    : null;
  const winningTrades = trades.filter((trade) => Number(trade.pnl) > 0);
  const losingTrades = trades.filter((trade) => Number(trade.pnl) < 0);
  const averageWin = average(winningTrades.map((trade) => Number(trade.pnl)));
  const averageLoss = average(losingTrades.map((trade) => Math.abs(Number(trade.pnl))));
  const profitLossRatio = averageWin !== null && averageLoss
    ? averageWin / averageLoss
    : null;
  const grossProfit = winningTrades.reduce(
    (sum, trade) => sum + Number(trade.pnl),
    0
  );
  const grossLoss = losingTrades.reduce(
    (sum, trade) => sum + Math.abs(Number(trade.pnl)),
    0
  );
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : null;
  const benchmarkReturnPercent = benchmarkReturn(
    benchmarkRows,
    firstDate,
    lastDate
  );

  const contributionMap = new Map();
  for (const trade of trades) {
    const row = contributionMap.get(trade.code) || {
      code: trade.code,
      name: trade.name,
      tradeCount: 0,
      winningTrades: 0,
      losingTrades: 0,
      pnl: 0
    };
    row.tradeCount += 1;
    if (trade.pnl > 0) row.winningTrades += 1;
    if (trade.pnl < 0) row.losingTrades += 1;
    row.pnl += Number(trade.pnl);
    contributionMap.set(trade.code, row);
  }
  const contributions = [...contributionMap.values()]
    .map((row) => ({
      ...row,
      pnl: round(row.pnl, 2),
      contributionPercent: round((row.pnl / startingCapital) * 100, 4),
      winRatePercent: row.tradeCount
        ? round((row.winningTrades / row.tradeCount) * 100, 2)
        : null
    }))
    .sort((left, right) =>
      right.pnl - left.pnl || left.code.localeCompare(right.code)
    );

  const metrics = {
    startingCapital: round(startingCapital, 2),
    endingCapital: round(endingCapital, 2),
    totalReturnPercent: round(totalReturnPercent, 4),
    annualizedReturnPercent: round(annualizedReturnPercent, 4),
    maxDrawdownPercent: round(maximumDrawdown, 4),
    sharpe: round(sharpe, 4),
    sharpeRatio: round(sharpe, 4),
    winRatePercent: trades.length
      ? round((winningTrades.length / trades.length) * 100, 2)
      : null,
    winRate: trades.length
      ? round((winningTrades.length / trades.length) * 100, 2)
      : null,
    profitLossRatio: round(profitLossRatio, 4),
    profitFactor: round(profitFactor, 4),
    averageTradeReturnPercent: round(average(
      trades.map((trade) => Number(trade.netReturnPercent))
    ), 4),
    tradeCount: trades.length,
    winningTrades: winningTrades.length,
    losingTrades: losingTrades.length,
    rejectedSignalCount: rejections.length,
    capacityRejected: rejections.filter((item) => item.reason === "capacity_limit").length,
    overlapRejected: rejections.filter((item) => item.reason === "same_stock_overlap").length,
    duplicateRejected: rejections.filter((item) => item.reason === "duplicate_signal").length,
    missingNextMarketDayRejected: rejections.filter(
      (item) => item.reason === "missingNextMarketDay"
    ).length,
    insufficientLotRejected: rejections.filter(
      (item) => item.reason === "insufficient_lot"
    ).length,
    maxPositionsObserved,
    securityCount: histories.size,
    tradingDays,
    benchmarkReturnPercent: round(benchmarkReturnPercent, 4),
    excessReturnPercent: benchmarkReturnPercent === null
      ? null
      : round(totalReturnPercent - benchmarkReturnPercent, 4)
  };

  const validationReasons = [
    benchmarkRows.length
      ? "退出仍沿用上游样本固定 exitDate 与 netReturn；若需精确市场日持有期，应由上游按主交易日历重建样本。"
      : "未提供基准交易日历，已使用个股历史日期并集，仅可作诊断。",
    metrics.securityCount < 30
      ? `股票篮子仅 ${metrics.securityCount} 只，少于30只，不能标记为已验证组合。`
      : ""
  ].filter(Boolean);
  return {
    id: "shared_strategy_portfolio",
    name: "多股票统一策略组合",
    status: "DIAGNOSTIC",
    validation: {
      accepted: false,
      status: "DIAGNOSTIC",
      reasons: validationReasons
    },
    range: { from: firstDate, to: lastDate },
    settings: {
      startingCapital: round(startingCapital, 2),
      maxPositions,
      lotSize,
      maxPositionPercent,
      rangeFrom: firstDate,
      rangeTo: lastDate,
      annualTradingDays,
      annualRiskFreeRatePercent
    },
    methodology: {
      signalTiming: "信号只决定次一市场交易日开盘候选，不使用其后的行情排序",
      entry: "信号日后的首个市场交易日开盘入场；停牌或缺失该日K线则拒绝",
      sizing: "按开盘前现金/空闲席位与单股仓位上限孰低确定目标金额，再向下取A股整手；当日退出持仓仍占用席位",
      exit: "固定退出日收盘按样本 netReturn 结算",
      costs: "sample.netReturn 已含双边成本，组合层不重复扣费",
      exitPrecision: "exitDate 沿用上游样本口径；未把个股第N根K线宣称为精确的第N个市场交易日",
      calendar: benchmarkRows.length
        ? "使用 benchmarkHistory 作为主市场交易日历"
        : "未提供基准时使用个股交易日并集（诊断降级）",
      markToMarket: "未退出持仓按当日历史收盘价盯市，停牌日沿用最近收盘价",
      eventOrder: "开盘处理新入场，收盘处理退出；当日退出所得次日才可再用",
      duplicateRule: "同股同信号日及持有区间的重复信号只接受一条",
      tieBreak: "优先级降序，其后按策略ID、股票代码、信号日、退出日和样本ID排序"
    },
    metrics,
    equityCurve,
    contributions,
    trades,
    rejections
  };
}

module.exports = {
  simulateStrategyPortfolio
};
