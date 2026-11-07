import { shanghaiDateTag } from "../../dateUtils";
import { nullableNumber } from "../../numericValue";
import type { PaperPosition } from "../../domain/paperSimulationTypes";
import type { AnalysisPayload } from "../market/analysisTypes";

const positive = (value: unknown) => { const n = nullableNumber(value); return n !== null && n > 0 ? n : null; };
export const paperPriceLimitRate = (code: string, name = "", date = shanghaiDateTag()): number | null => {
  const beijing = /^(?:(?:43|83|87|88)\d{4}|920\d{3})$/.test(code);
  if (!beijing && !/^(?:60|00|30|68)\d{4}$/.test(code)) return null;
  // 上市首日（N）及创业板/科创板前五日（C）无涨跌幅限制；北交所新股同样先判断。
  if (/^[NC]/i.test(name)) return null;
  if (beijing) return .3;
  if (/^(?:30|68)/.test(code)) return .2;
  // 与 electron/price-limit-rules.cjs 的 MAIN_BOARD_ST_RATE_EFFECTIVE 同步：
  // 沪深主板 ST/*ST 自 2026-07-06 起由 5% 调整为 10%（新规）。
  return /\*?ST/i.test(name) && date < "2026-07-06" ? .05 : .1;
};
// Broker commission is a user setting; this simulation models a RMB 5 minimum.
// ChinaClear transfer fee 0.01‰ both sides; stamp tax 0.5‰ seller only.
export const calcAshareBuyFee = (value: number, commissionPercent: number) => Math.max(5, value * commissionPercent / 100) + value * .00001;
export const calcAshareSellFee = (value: number, commissionPercent: number) => calcAshareBuyFee(value, commissionPercent) + value * .0005;
export const paperDate = (value: string): string => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : Number.isFinite(Date.parse(value)) ? shanghaiDateTag(new Date(value)) : "";

export const isPostShanghai1500 = (isoString: string): boolean => {
  const d = new Date(isoString);
  if (!Number.isFinite(d.getTime())) return false;
  const shanghaiHour = new Date(d.getTime() + 8 * 3600 * 1000).getUTCHours();
  return shanghaiHour >= 15;
};

export const paperQuoteEvidence = (payload: AnalysisPayload): Partial<PaperPosition> => ({
  quoteDate: payload.updatedAt && Number.isFinite(Date.parse(payload.updatedAt)) ? paperDate(payload.updatedAt) : "",
  quoteName: String(payload.quote?.name || payload.security?.name || ""),
  ...(nullableNumber(payload.quote?.volume) !== null ? { quoteVolume: Math.max(0, Number(payload.quote?.volume)) } : {}),
  ...(positive(payload.quote?.preClose) !== null ? { quotePreClose: Number(payload.quote?.preClose) } : {}),
  ...(positive(payload.quote?.latest) !== null && payload.updatedAt &&
    isPostShanghai1500(payload.updatedAt) && paperDate(payload.updatedAt) === shanghaiDateTag()
      ? { lastObservedClose: Number(payload.quote.latest), lastObservedCloseDate: paperDate(payload.updatedAt) } : {})
});

/**
 * F-01 修复：除权阻塞必须能在「事实澄清后」自动解除，否则持仓永久无法平仓。
 *
 * 原实现开头无条件 `if (position.settlementBlockedReason) return ...`，
 * 导致后续所有恢复判定永远得不到评估 —— 阻塞一旦写入即死锁，用户只能重装。
 *
 * 新的语义是「按事实判定」而不是「按历史标记判定」：
 *   · 除权事实**仍在**（名称仍带 XR/XD/DR，或行情仍声明 corporateAction）→ 继续阻塞（安全底线不变）
 *   · 除权事实**已消失**（前收已与记录一致 / 行情已推进到新交易日）→ 解除阻塞
 *
 * 注意：解除阻塞**不等于**放行撮合。解除后仍会走 paperMatchBlock 的
 * T+1 / 涨跌停 / 停牌 / 前收 等全部校验，安全性不降低。
 */
export const paperCorporateActionBlock = (position: PaperPosition, payload: AnalysisPayload): string => {
  const name = String(payload.quote?.name || payload.security?.name || "");
  const preClose = positive(payload.quote?.preClose);
  const today = paperDate(payload.updatedAt || "");
  const mismatched = Boolean(
    position.lastObservedClose && position.lastObservedCloseDate && today &&
    position.lastObservedCloseDate < today && preClose !== null &&
    Math.abs(position.lastObservedClose - preClose) > .011
  );

  // 事实一：除权标记仍在（名称前缀 / 行情声明）。这是最强的阻塞依据，优先保留。
  const corporateActionPending = /^(?:XR|XD|DR)/i.test(name) || Boolean(payload.quote?.corporateAction);

  // 事实二：前收与已记录收盘仍不一致 —— 说明除权尚未被行情吸收。
  // 若已有阻塞标记但两项事实都不再成立，说明除权已被后续行情消化，可以解除。
  if (!corporateActionPending && !mismatched) return "";

  // 仍阻塞。沿用已记录的更具体原因（若有），否则给出本次判定的原因。
  if (position.settlementBlockedReason && (corporateActionPending || mismatched)) {
    return position.settlementBlockedReason;
  }
  if (corporateActionPending) return "除权除息资料待核实，暂停撮合；需核对股份及现金权益";
  return "前收盘参考价与已记录收盘价不一致（除权或缺失交易日待核实），暂停撮合";
};

export const paperMatchBlock = (position: PaperPosition, side: "buy" | "sell", executionPrice: number): string => {
  // F-01 修复：这里保留「有阻塞标记即拒绝撮合」的安全底线（撮合路径不自行解除阻塞，
  // 解除只发生在行情同步时按事实判定），但错误信息会带上解除指引，
  // 避免用户面对一句无法操作的原因。
  if (position.settlementBlockedReason) {
    return `${position.settlementBlockedReason}（待行情核实除权/前收后自动解除，也可在持仓行手动确认）`;
  }
  const today = shanghaiDateTag();
  if (side === "sell" && (!paperDate(position.openedAt) || paperDate(position.openedAt) >= today)) return "T+1：当日买入股份尚不可卖出";
  if (position.quoteDate !== today) return "缺少今日有效行情，暂停撮合";
  if (!(position.quoteVolume && position.quoteVolume > 0)) return "停牌或缺少有效成交量，暂停撮合";
  if (!(positive(executionPrice) && positive(position.latestPrice))) return "缺少有效价格，暂停撮合";
  const reference = positive(position.quotePreClose);
  if (reference === null) return "缺少前收盘参考价，暂停撮合";
  const rate = paperPriceLimitRate(position.code, position.quoteName || position.name, today);
  if (rate === null && !/^[NC]/i.test(position.quoteName || position.name)) return "当前证券不属于支持的A股撮合范围";
  if (rate !== null) {
    // 与 electron/price-limit-rules.cjs 的 roundPrice 一致：+1e-7 修正浮点（17.15×1.1 应为 18.87）。
    const upper = Math.round(reference * (1 + rate) * 100 + 1e-7) / 100;
    const lower = Math.round(reference * (1 - rate) * 100 + 1e-7) / 100;
    // No order book is available: a quote at the limit is conservatively unfillable.
    if (side === "buy" && (position.latestPrice >= upper - .001 || executionPrice > upper + .001)) return "涨停或含滑点成交价超涨停价，暂停买入";
    if (side === "sell" && (position.latestPrice <= lower + .001 || executionPrice < lower - .001)) return "跌停或含滑点成交价低于跌停价，暂停卖出";
  }
  return "";
};

/** 申报数量规则：科创板（688/689）单笔不少于 200 股、超出部分 1 股递增；北交所不少于 100 股、1 股递增；其余 100 股整数倍。 */
export const paperLotRule = (code: string): { min: number; step: number } =>
  /^68[89]\d{3}$/.test(code) ? { min: 200, step: 1 }
    : /^(?:(?:43|83|87|88)\d{4}|920\d{3})$/.test(code) ? { min: 100, step: 1 } : { min: 100, step: 100 };
/** 把可买股数按申报规则向下取整；不足最低申报数返回 0。 */
export const paperRoundShares = (code: string, shares: number): number => {
  const { min, step } = paperLotRule(code);
  const rounded = Math.floor(Math.max(0, shares) / step) * step;
  return rounded >= min ? rounded : 0;
};
