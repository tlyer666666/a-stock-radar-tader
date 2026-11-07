"use strict";

const DEFAULT_ACCOUNT = Object.freeze({ initialCash: 1000000, maxPositions: 6, maxPositionPercent: .15,
  maxIndustryPercent: .25, maxGrossExposurePercent: .6, riskPerPositionPercent: .005,
  maxRiskPercent: .03, maxParticipationPercent: .01, gapStressPercent: .03 });
// Money rounds half up on the cent. `+ Number.EPSILON` is orders of magnitude
// below the float error of `value * 100`, so 2.675 used to become 2.67; the
// 1e-7 guard is the smallest offset that is reliably larger than that error.
// Kept local (not imported) so this module stays dependency-free for the worker.
const money = value => Math.round(value * 100 + 1e-7) / 100;
const finite = value => typeof value === "number" && Number.isFinite(value);
function normalizeAccount(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("account must be an object");
  for (const key of Object.keys(input)) if (!(key in DEFAULT_ACCOUNT)) throw new TypeError(`Unknown account setting ${key}`);
  const config = { ...DEFAULT_ACCOUNT, ...input };
  for (const [key, value] of Object.entries(config)) if (!finite(value) || value < 0 ||
    (key === "initialCash" && value <= 0) || (key === "maxPositions" && (!Number.isSafeInteger(value) || value < 1)) ||
    (key.endsWith("Percent") && value > 1)) throw new TypeError(`Invalid account.${key}`);
  return config;
}
function fee(value, side, execution) {
  return money(money(Math.max(execution.minCommission, value * execution.commissionBps / 10000)) +
    money(value * execution.transferFeeBps / 10000) + (side === "sell" ? money(value * execution.sellTaxBps / 10000) : 0));
}
function historicalState(stock, date) {
  return stock.statusHistory.filter(state => state.date <= date).at(-1) || {};
}
function simulateSharedAccount({ samples, calendar, securities, execution, config: input, dataErrors = [] }) {
  const config = normalizeAccount(input);
  const stocks = new Map(securities.map(stock => [stock.security.code, stock]));
  const positions = new Map(); const trades = []; const rejections = []; const equityCurve = [];
  let cash = config.initialCash; let totalFees = 0; let peak = cash; let drawdown = 0; let evidenceComplete = true;
  const ordered = [...samples].sort((a, b) => (a.entryDate || a.signalDate).localeCompare(b.entryDate || b.signalDate) || a.code.localeCompare(b.code) || a.signalDate.localeCompare(b.signalDate));
  const values = () => [...positions.values()].reduce((sum, item) => sum + item.shares * item.mark, 0);
  for (const date of calendar) {
    // Only actual modeled open exits release funds. Suspended/locked/unresolved positions stay reserved.
    for (const [code, position] of positions) {
      if (position.exitDate !== date || position.status !== "closed") continue;
      const exitFees = fee(position.shares * position.exitPrice, "sell", execution);
      position.exitProceeds = money(position.shares * position.exitPrice - exitFees);
      position.exitFees = exitFees; totalFees += exitFees; cash = money(cash + position.exitProceeds);
      position.netPnl = money(position.exitProceeds - position.entryCost);
      position.netReturnPercent = Number(((position.exitProceeds / position.entryCost - 1) * 100).toFixed(6));
      positions.delete(code);
    }
    for (const sample of ordered.filter(item => item.entryDate === date)) {
      const reject = reason => rejections.push({ code: sample.code, signalDate: sample.signalDate, entryDate: date, reason });
      if (positions.has(sample.code)) { reject("already_holding_security"); continue; }
      if (positions.size >= config.maxPositions) { reject("max_positions"); continue; }
      const stock = stocks.get(sample.code); const state = historicalState(stock, sample.signalDate);
      // Never borrow today's industry for historical allocations: missing sectors share one conservative bucket.
      const industry = state.industry || "UNKNOWN";
      const star = /^68[89]/.test(sample.code); const beijing = /^(?:[48]|920)/.test(sample.code);
      const unit = historicalState(stock, date);
      const minimum = unit.minimumBuyQuantity ?? (star ? 200 : 100); const step = unit.quantityStep ?? (star || beijing ? 1 : 100);
      const equity = cash + values();
      const industryValue = [...positions.values()].filter(item => item.industry === industry).reduce((sum, item) => sum + item.shares * item.mark, 0);
      const riskUsed = [...positions.values()].reduce((sum, item) => sum + item.riskReserved, 0);
      const amounts = stock.rawRows.filter(row => row.date <= sample.signalDate).slice(-20).map(row => row.amount).sort((a, b) => a - b);
      const medianAmount = amounts.length ? (amounts[Math.floor((amounts.length - 1) / 2)] + amounts[Math.floor(amounts.length / 2)]) / 2 : 0;
      const maxValue = Math.max(0, Math.min(cash, equity * config.maxPositionPercent,
        equity * config.maxIndustryPercent - industryValue, equity * config.maxGrossExposurePercent - values(), medianAmount * config.maxParticipationPercent));
      const riskBudget = Math.max(0, Math.min(equity * config.riskPerPositionPercent, equity * config.maxRiskPercent - riskUsed));
      const price = sample.entryPrice; const stopFill = Math.max(0, Math.floor(sample.plan.stop * (1 - config.gapStressPercent) * (1 - (execution.slippageBps || 0) / 10000) * 100) / 100);
      const maxShares = Math.floor(maxValue / price);
      let shares = maxShares < minimum ? 0 : minimum + Math.floor((maxShares - minimum) / step) * step;
      const risk = quantity => quantity * Math.max(0, price - stopFill) + fee(quantity * price, "buy", execution) + fee(quantity * stopFill, "sell", execution);
      // Binary search lot count avoids O(shares) work for high-notional penny stocks.
      let low = 0; let high = shares ? (shares - minimum) / step + 1 : 0;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2); const quantity = minimum + (middle - 1) * step;
        if (quantity * price + fee(quantity * price, "buy", execution) <= cash + 1e-9 && risk(quantity) <= riskBudget + 1e-9) low = middle;
        else high = middle - 1;
      }
      shares = low ? minimum + (low - 1) * step : 0;
      if (!shares) { reject("account_capacity_or_risk"); continue; }
      const entryFees = fee(shares * price, "buy", execution); const entryCost = money(shares * price + entryFees);
      const trade = { ...sample, shares, entryFees, entryCost, exitFees: null, exitProceeds: null,
        netReturnPercent: null, netPnl: null, industry, industryEvidence: state.industry ? "historical_status" : "unknown_conservative_bucket",
        riskReserved: money(risk(shares)), medianAmount20: medianAmount, participationPercent: shares * price / medianAmount, mark: price, markDate: date };
      cash = money(cash - entryCost); totalFees += entryFees; positions.set(sample.code, trade); trades.push(trade);
    }
    let staleMarks = 0;
    for (const position of positions.values()) {
      const stock = stocks.get(position.code); const row = stock.rawByDate.get(date);
      const unsafe = position.status === "unresolved" && position.unresolvedDate && date >= position.unresolvedDate;
      if (!unsafe && finite(row?.close) && row.close > 0) { position.mark = row.close; position.markDate = date; }
      else { staleMarks++; evidenceComplete = false; }
    }
    const grossExposure = money(values()); const equity = money(cash + grossExposure); peak = Math.max(peak, equity);
    drawdown = Math.min(drawdown, (equity / peak - 1) * 100);
    equityCurve.push({ date, cash, grossExposure, equity, positions: positions.size, staleMarks,
      riskReserved: money([...positions.values()].reduce((sum, item) => sum + item.riskReserved, 0)) });
  }
  const unresolved = trades.filter(trade => trade.status === "unresolved").length;
  return { schemaVersion: 1, scope: "shared-capital-account", config, cash, trades, rejections,
    unenteredSamples: samples.filter(sample => !sample.entryDate), holdings: [...positions.values()], equityCurve,
    metrics: { signals: samples.length, entered: trades.length, closed: trades.filter(trade => trade.status === "closed").length,
      censored: trades.filter(trade => trade.status === "censored").length, unresolved,
      pending: samples.filter(sample => sample.status === "pending").length,
      independentRejected: samples.filter(sample => sample.status === "rejected").length,
      independentUnresolved: samples.filter(sample => sample.status === "unresolved" && !sample.entryDate).length,
      accountRejected: rejections.length, modeledFees: money(totalFees), finalEquity: equityCurve.at(-1)?.equity ?? config.initialCash,
      modeledReturnPercent: (equityCurve.at(-1)?.equity / config.initialCash - 1) * 100 || 0,
      maxDrawdownPercent: drawdown, delayedExitSessions: trades.reduce((sum, trade) => sum + (trade.delayedExitSessions || 0), 0),
      completeEquityEvidence: evidenceComplete && dataErrors.length === 0 && !samples.some(sample => sample.status === "unresolved") },
    qualification: { dataCoverageComplete: dataErrors.length === 0, dataErrors: structuredClone(dataErrors), returnSuperiorityVerified: false, limitations: [...(dataErrors.length ? ["存在证券输入异常，已隔离相关日期，账户权益证据不完整。"] : []), "仅为共享资金日线撮合模型；权益含未平仓估值，未扣除未来清仓成本。", "行业缺失归为同一保守桶；未知行情冻结最后可靠估值并标记不完整，不能作为完整收益证据。", "持仓风险按冻结止损、压力跳空与双边费用预留；真实跳空损失仍可能超过预算。"] } };
}
module.exports = { DEFAULT_ACCOUNT, normalizeAccount, simulateSharedAccount, money };
