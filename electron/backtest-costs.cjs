'use strict';

// Fixed scenario assumptions, not a historical tax schedule. Keep the values with each report.
const DEFAULT_COSTS = Object.freeze({ commissionBps: 7, slippageBps: 2, sellTaxBps: 5, transferFeeBps: 0.1, minCommission: 5 });
const roundMoney = value => (value < 0 ? -1 : 1) * Math.round(Math.abs(value) * 100 + 1e-7) / 100;
function roundTripBps(model = DEFAULT_COSTS) {
  return 2 * (model.commissionBps + model.slippageBps + model.transferFeeBps) + model.sellTaxBps;
}
function fees(value, side, model) {
  const commission = roundMoney(Math.max(model.minCommission, value * model.commissionBps / 10000));
  const transfer = roundMoney(value * model.transferFeeBps / 10000);
  const tax = side === 'sell' ? roundMoney(value * model.sellTaxBps / 10000) : 0;
  return { commission, transfer, tax, total: roundMoney(commission + transfer + tax) };
}
module.exports = { DEFAULT_COSTS, roundTripBps, fees };
