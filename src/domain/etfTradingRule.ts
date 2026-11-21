/**
 * 场内基金（ETF/LOF）的交易规则识别：T+0 / T+1、免印花税和过户费、0.001 元最小价位。
 *
 * 交易所规则：跨境（含港股通、海外）、商品（黄金、商品期货）、债券、货币 ETF 可当日回转（T+0）；
 * 宽基、行业主题等 A 股股票型 ETF 为 T+1。只有代码和名称时按名称识别，识别不准可在做T参数里手动指定。
 * 跨境名称规则与 electron/etf-market.cjs 的 CROSS_BORDER_NAME / DOMESTIC_MIX_NAME 保持一致。
 */

export type TradingRuleSetting = "auto" | "t0" | "t1";

const FUND_CODE = /^(?:5[1-9]\d{4}|15\d{4}|16\d{4})$/;
const CROSS_BORDER_NAME = /港股|恒生|香港|H股|中概|纳指|纳斯达克|标普|道琼斯|美国|日经|日本|东证|德国|法国|英国|欧洲|亚太|东南亚|沙特|巴西|越南|印度|新兴市场|全球|海外|中韩/;
const DOMESTIC_MIX_NAME = /沪港深|A\+H|AH|两岸|中华/;
/** 商品、债券、货币类：黄金股、有色金属等是股票型，不算。 */
const COMMODITY_BOND_MONEY_NAME = /黄金(?!股)|上海金|白银|豆粕|有色期货|能源化工|商品|原油|债|短融|货币|现金(?!流)|日利|添益|保证金|快线|理财/;
const EQUITY_LOOKALIKE_NAME = /黄金股|金属|矿业/;

/** 场内基金（ETF/LOF）代码：沪市 5 开头、深市 15/16 开头。 */
export const isExchangeFundCode = (code: string): boolean => FUND_CODE.test(String(code || "").trim());

/** 按代码与名称识别是否为 T+0 品种；非基金代码一律 T+1。 */
export function detectT0(code: string, name = ""): boolean {
  const value = String(code || "").trim();
  if (!isExchangeFundCode(value)) return false;
  // 沪市 511 开头是债券 / 货币 ETF，518 开头是黄金 ETF。
  if (/^51[18]\d{3}$/.test(value)) return true;
  const base = String(name || "").replace(/^XD/, "").split(/ETF|LOF/i)[0] || "";
  if (CROSS_BORDER_NAME.test(base) && !DOMESTIC_MIX_NAME.test(base)) return true;
  return COMMODITY_BOND_MONEY_NAME.test(base) && !EQUITY_LOOKALIKE_NAME.test(base);
}

/** 用户手动指定优先，其余按代码与名称自动识别。 */
export function resolveT0(code: string, name: string, setting: TradingRuleSetting = "auto"): boolean {
  if (setting === "t0") return true;
  if (setting === "t1") return false;
  return detectT0(code, name);
}

/** 最小报价单位：场内基金 0.001 元，股票 0.01 元。 */
export const priceTickOf = (code: string): number => isExchangeFundCode(code) ? 0.001 : 0.01;
export const priceDecimalsOf = (code: string): number => isExchangeFundCode(code) ? 3 : 2;
