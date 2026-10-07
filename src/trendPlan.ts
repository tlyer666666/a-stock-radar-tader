/** The position and exit rules in the user's Word plan, section 3.
 * Values and market quantity rules must be supplied and verified by the user.
 * These calculations do not place orders, obtain calendars or update a frozen stop.
 */
export type TrendPositionInput = {
  netAssetValue: number;
  entryPrice: number;
  stopPrice: number;
  maxEntryPrice: number;
  /** Optional frozen breakout floor used only by quality-v2 plans. */
  minEntryPrice?: number;
  /** Existing exposure as a ratio of net assets, e.g. 0.20 for 20%. */
  industryExposureRatio: number;
  portfolioExposureRatio: number;
  openPositions: number;
  cashAvailable: number;
  feeReserve: number;
  minimumBuyQuantity: number;
  quantityStep: number;
  alreadyHeld: boolean;
  permissionVerified: boolean;
  announcementVerified: boolean;
  corporateActionAligned: boolean;
  marketGate: "open" | "blocked" | "unknown";
};

export type TrendPositionResult = {
  eligible: boolean;
  reasons: string[];
  shares: number;
  cost: number;
  plannedLoss: number;
  positionRatio: number;
  riskRatio: number;
  riskBudget: number;
  /** Maximum principal after the specified fee reserve. */
  budget: number;
  stopDistanceRatio: number;
};

const positive = (value: number) => Number.isFinite(value) && value > 0;
const nonnegative = (value: number) => Number.isFinite(value) && value >= 0;
const ratio = (value: number) => nonnegative(value) && value <= 1;
const money = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

export function calculateTrendPosition(input: TrendPositionInput): TrendPositionResult {
  const reasons: string[] = [];
  const result: TrendPositionResult = {
    eligible: false, reasons, shares: 0, cost: 0, plannedLoss: 0,
    positionRatio: 0, riskRatio: 0, riskBudget: 0, budget: 0, stopDistanceRatio: 0
  };
  if (!positive(input.netAssetValue)) reasons.push("请填写有效账户净值");
  if (![input.entryPrice, input.stopPrice, input.maxEntryPrice].every(positive)) {
    reasons.push("拟成交价、冻结止损 S 和 Pmax 必须为有效正数");
  }
  if (input.minEntryPrice !== undefined && (!positive(input.minEntryPrice) || input.minEntryPrice <= input.stopPrice || input.minEntryPrice > input.maxEntryPrice)) {
    reasons.push("最低入场价必须高于冻结止损且不超过 Pmax，请核验策略快照");
  }
  if (!ratio(input.industryExposureRatio) || !ratio(input.portfolioExposureRatio)) {
    reasons.push("现有行业及组合仓位须在 0% 至 100% 之间");
  }
  if (!Number.isSafeInteger(input.openPositions) || input.openPositions < 0) reasons.push("持仓只数须为非负整数");
  if (!nonnegative(input.cashAvailable) || !nonnegative(input.feeReserve)) reasons.push("可用现金和预留费用须为有效非负金额");
  if (![input.minimumBuyQuantity, input.quantityStep].every((value) => Number.isSafeInteger(value) && value > 0)) {
    reasons.push("请核验并填写所属市场的最低买入数量和数量步长");
  }
  if (input.alreadyHeld !== false) reasons.push("同股持仓未结束前不重复开仓，不对亏损持仓补仓");
  if (input.permissionVerified !== true) reasons.push("交易权限及当日交易、数量规则尚未核验");
  if (input.announcementVerified !== true) reasons.push("公告与重大风险尚未核验");
  if (input.corporateActionAligned !== true) reasons.push("公司行为及价格口径尚未核对，请先复核冻结止损");
  if (input.marketGate !== "open") {
    reasons.push(input.marketGate === "blocked" ? "中证全指低于 MA60，暂停新开仓" : "市场过滤状态未知，暂不生成开仓计划");
  }
  if (reasons.length) return result;

  result.riskBudget = money(input.netAssetValue * 0.005);
  result.stopDistanceRatio = (input.entryPrice - input.stopPrice) / input.entryPrice;
  if (input.entryPrice <= input.stopPrice) reasons.push("拟成交价必须高于冻结止损 S");
  if (input.entryPrice > input.maxEntryPrice) reasons.push("拟成交价超过 Pmax，取消本次入场");
  if (input.minEntryPrice !== undefined && input.entryPrice < input.minEntryPrice) reasons.push("拟成交价低于冻结突破下限，取消本次入场");
  if (result.stopDistanceRatio > 0.08 + 1e-10) reasons.push("拟成交价至止损的幅度超过 8%");
  if (input.openPositions >= 6) reasons.push("同时持有最多 6 只，当前无新增名额");
  if (input.industryExposureRatio >= 0.25) reasons.push("同一一级行业仓位已达 25% 上限");
  if (input.portfolioExposureRatio >= 0.6) reasons.push("组合总仓位已达 60% 上限");
  if (reasons.length) return result;

  const positionCap = Math.min(0.15, 0.005 / result.stopDistanceRatio,
    0.25 - input.industryExposureRatio, 0.6 - input.portfolioExposureRatio);
  const principalBudget = Math.max(0,
    Math.min(input.netAssetValue * positionCap, input.cashAvailable) - input.feeReserve);
  result.budget = Math.floor((principalBudget + 1e-8) * 100) / 100;
  const maximumShares = Math.floor((principalBudget + 1e-8) / input.entryPrice);
  if (maximumShares < input.minimumBuyQuantity) {
    reasons.push("扣除预留费用后，可买数量不足已核验的最低买入数量");
    return result;
  }
  const shares = input.minimumBuyQuantity +
    Math.floor((maximumShares - input.minimumBuyQuantity) / input.quantityStep) * input.quantityStep;
  const cost = shares * input.entryPrice;
  const loss = shares * (input.entryPrice - input.stopPrice);
  // Guard against unsafe numeric inputs rather than yielding a misleading plan.
  if (!Number.isSafeInteger(shares) || !Number.isFinite(cost) ||
      cost + input.feeReserve > input.cashAvailable + 1e-8 ||
      loss > input.netAssetValue * 0.005 + 1e-8) {
    reasons.push("数量或预算无法可靠计算，请复核账户、价格及交易单位");
    return result;
  }
  return { ...result, eligible: true, shares, cost: money(cost), plannedLoss: money(loss),
    positionRatio: cost / input.netAssetValue, riskRatio: loss / input.netAssetValue };
}

export type TrendExitInput = {
  /** Saved initial S, never moved down because an ordinary price decline occurred. */
  stopPrice: number;
  /** Explicitly confirmed exchange trading-session count; entry day is day 1. */
  holdingTradingDays: number;
  close: number;
  ma20: number;
  /** The immediately previous trading session after entry, not any earlier close. */
  previousClose?: number;
  previousMa20?: number;
  corporateActionAligned: boolean;
};

export type TrendExitResult = {
  action: "exit-next-open" | "hold" | "needs-data";
  reasons: string[];
};

export function evaluateTrendExit(input: TrendExitInput): TrendExitResult {
  if (input.corporateActionAligned !== true) {
    return { action: "needs-data", reasons: ["公司行为及止损、收盘价、MA20 的价格口径尚未核验"] };
  }
  if (!positive(input.stopPrice) || !positive(input.close) ||
      !Number.isSafeInteger(input.holdingTradingDays) || input.holdingTradingDays < 1) {
    return { action: "needs-data", reasons: ["请填写冻结止损、当日收盘和准确的持仓交易日数；买入日算第 1 日"] };
  }
  const reasons: string[] = [];
  if (input.close < input.stopPrice) reasons.push("收盘价低于冻结止损 S，计划下一可交易日开盘退出");
  const currentMaKnown = positive(input.ma20);
  const previousKnown = positive(input.previousClose ?? NaN) && positive(input.previousMa20 ?? NaN);
  if (input.holdingTradingDays >= 2 && currentMaKnown && previousKnown &&
      input.close < input.ma20 && input.previousClose! < input.previousMa20!) {
    reasons.push("持仓后连续两日收盘低于各自 MA20，计划下一可交易日开盘退出");
  }
  if (input.holdingTradingDays >= 29) {
    reasons.push(input.holdingTradingDays === 29
      ? "第 29 个持仓交易日收盘，安排第 30 日开盘退出"
      : "已到最长持有期，原应在第 30 日开盘退出；如延迟，安排下一可交易日开盘退出");
  }
  if (reasons.length) return { action: "exit-next-open", reasons };
  if (!currentMaKnown || (input.holdingTradingDays >= 2 && input.close < input.ma20 && !previousKnown)) {
    return { action: "needs-data", reasons: ["缺少连续两个持仓交易日的收盘价或 MA20，无法完成退出复核"] };
  }
  return { action: "hold", reasons: ["按已填写数据暂未触发退出条件；继续按每个交易日收盘复核"] };
}
