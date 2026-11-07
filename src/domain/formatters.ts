import { nullableNumber } from "../numericValue";
export { nullableNumber };

export const fmt = (value: number | null | undefined, digits = 2) =>
  typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "--";

/** 金额展示风格：换算位（亿/万）、单位分隔串与「不足 1 万」的写法。 */
export type MoneyStyle = {
  /** ≥1e8 时保留几位小数 */
  billionDigits: number;
  /** ≥1e4 时保留几位小数 */
  tenThousandDigits: number;
  /** 数字与「亿/万」之间的分隔串 */
  unitSeparator: string;
  /** <1e4 时的展示方式 */
  small: (value: number) => string;
};

/* ── B-03：金额展示只保留一套实现 ─────────────────────────────────────────────
 *
 * 修复前同一笔 1_200_000 元成交额有三种写法：本文件 fmtMoney「120.00 万」、
 * MultiStockCompareView 自带的「120万」、PreviousLimitUpFailedBoards 的「0.01亿」。
 * 三处各自维护精度与单位，同一只股票在不同面板显示不同量级。
 *
 * 处理方式：换算逻辑只保留 moneyText(value, style) 一份，全站默认口径由
 * DEFAULT_MONEY_STYLE 描述；导出两个恒等的入口：
 *   · fmtMoney  —— 既有调用点（涨停池 / 持仓 / 板块 / 复盘）的入口，输出不变；
 *   · fmtAmount —— 同一函数的别名，新调用点用它可以表意更直接。
 * 确有精度差异的调用方只能经 createNumberFormatters 显式传 MoneyStyle，
 * 不得再复制一份换算代码（R-01/S-07 的收敛原则）。
 */
export const DEFAULT_MONEY_STYLE: MoneyStyle = {
  billionDigits: 2,
  tenThousandDigits: 2,
  unitSeparator: " ",
  small: (value) => value.toLocaleString("zh-CN", { maximumFractionDigits: 2 })
};

const moneyText = (value: number, style: MoneyStyle): string => {
  const sign = value < 0 ? "-" : "";
  const absolute = Math.abs(value);
  if (absolute >= 1e8) return `${sign}${(absolute / 1e8).toFixed(style.billionDigits)}${style.unitSeparator}亿`;
  if (absolute >= 1e4) return `${sign}${(absolute / 1e4).toFixed(style.tenThousandDigits)}${style.unitSeparator}万`;
  return style.small(value);
};

export const fmtMoney = (value: number | null | undefined): string =>
  typeof value === "number" && Number.isFinite(value) ? moneyText(value, DEFAULT_MONEY_STYLE) : "--";

/** fmtMoney 的别名：同一个函数，不是另一份实现。 */
export const fmtAmount = fmtMoney;

/* ── B-08：带符号百分比同样只保留一套实现 ─────────────────────────────────────
 *
 * 历史边界等位置曾出现 1 位小数、无正负号、直接插值等写法；统一为
 * 「两位小数 + 显式正负号」，缺失/非法输入返回 "--"。
 */
const percentText = (value: number, digits: number) =>
  `${value >= 0 ? "+" : ""}${value.toFixed(digits)}%`;

export const fmtPercent = (value: unknown, digits = 2): string => {
  const parsed = nullableNumber(value);
  return parsed === null ? "--" : percentText(parsed, digits);
};

export const subtractNullable = (left: unknown, right: unknown): number | null => {
  const leftNumber = nullableNumber(left);
  const rightNumber = nullableNumber(right);
  return leftNumber === null || rightNumber === null ? null : leftNumber - rightNumber;
};

/* ── R-01 / S-07：格式化实现收敛 ─────────────────────────────────────────────
 *
 * 起因：number / fmt / pct / unit / money 在 MultiStockCompareView、ProfessionalReview、
 * StrategySignalsView 各有一份，加上本文件共 4 套。同一个数值在不同面板会渲染成
 * 不同文本（金额是否有空格、万位保留几位小数），用户对比同一只股票的两个页面
 * 会看到不一致的数字，且改一处必然漏掉其它三处。
 *
 * 处理方式：不强行统一输出 —— 那会改变用户看到的文案。改为提供一个参数化工厂，
 * 各模块只声明自己的口径差异（小数位、金额风格、解析函数），差异从"隐式复制代码"
 * 变成"显式配置参数"。金额的基层换算与 DEFAULT_MONEY_STYLE 共享同一条 moneyText。
 *
 * 解析函数作为**必填参数**传入，因为 StrategySignalsView 刻意保留了自己的语义：
 * 对 "   " / true / [] 等输入，它走 Number() 隐式转换（得到 0），而 numericValue
 * 一律返回 null。统一会改变 66 处调用点的行为，属于行为变更，不在收敛范围。
 */

/** 把外部值解析成有限数字；无法解析返回 null。 */
export type NumberParser = (value: unknown) => number | null;

export type NumberFormatters = {
  /** 缺失时返回 fallback（默认 0）。 */
  number: (value: unknown, fallback?: number) => number;
  /** 缺失时返回 "--"。 */
  fmt: (value: unknown, digits?: number) => string;
  /** 带正负号的百分比；缺失时返回 "--"。 */
  pct: (value: unknown, digits?: number) => string;
  /** 数字 + 后缀；缺失时返回 "--"。 */
  unit: (value: unknown, digits: number, suffix: string) => string;
  /** 亿/万 金额；缺失时返回 "--"。 */
  money: (value: unknown) => string;
};

export function createNumberFormatters(
  parse: NumberParser,
  options: { fmtDigits?: number; pctDigits?: number; money?: MoneyStyle | ((value: number) => string) } = {}
): NumberFormatters {
  const fmtDigits = options.fmtDigits ?? 2;
  const pctDigits = options.pctDigits ?? 2;
  const moneyOption = options.money;

  const money: (value: unknown) => string =
    typeof moneyOption === "function"
      ? (value) => { const p = parse(value); return p === null ? "--" : moneyOption(p); }
      : (value) => {
          const p = parse(value);
          if (p === null) return "--";
          return moneyText(p, moneyOption ?? DEFAULT_MONEY_STYLE);
        };

  return {
    number: (value, fallback = 0) => { const p = parse(value); return p === null ? fallback : p; },
    fmt: (value, digits = fmtDigits) => { const p = parse(value); return p === null ? "--" : p.toFixed(digits); },
    pct: (value, digits = pctDigits) => {
      const p = parse(value);
      return p === null ? "--" : percentText(p, digits);
    },
    unit: (value, digits, suffix) => { const p = parse(value); return p === null ? "--" : `${p.toFixed(digits)}${suffix}`; },
    money
  };
}
