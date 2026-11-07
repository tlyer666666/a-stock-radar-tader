"use strict";

// 沪深主板风险警示股票的限幅从 5% 调为 10%，两市交易规则均自 2026-07-06 施行。
// 上证发〔2026〕41号：https://www.sse.com.cn/lawandrules/sselawsrules2025/trade/universal/c/c_20260424_10816492.shtml
// 深证上〔2026〕551号：https://www.szse.cn/lawrules/rule/trade/current/t20260424_620190.html
// 该日期可由环境变量 ASTOCK_MAIN_BOARD_ST_RATE_EFFECTIVE 覆盖（仅接受合法
// YYYY-MM-DD，非法值回退默认并只告警一次），便于来源更新后不改代码即调整。
//
// 一致性：前端 src/features/paper-simulation/paperTradingRules.ts 的同名阈值
// 由 electron/price-limit-rules.test.cjs 的一致性断言守护（比对下方默认常量）。
const DEFAULT_MAIN_BOARD_ST_RATE_EFFECTIVE = "2026-07-06";
const MAIN_BOARD_ST_RATE_EFFECTIVE = DEFAULT_MAIN_BOARD_ST_RATE_EFFECTIVE;
const CHINEXT_RATE_EFFECTIVE = "2020-08-24";

const warnedOverrideValues = new Set();
let cachedOverrideRaw = null;
let cachedEffectiveDate = MAIN_BOARD_ST_RATE_EFFECTIVE;

function strictIsoDate(value) {
  const text = String(value ?? "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return "";
  const parsed = new Date(`${text}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === text ? text : "";
}

// 每次调用都按当前 env 解析（带 raw 值缓存）。生产从不设置该变量时等价于常量。
function mainBoardStRateEffective(env = process.env) {
  const raw = String(env?.ASTOCK_MAIN_BOARD_ST_RATE_EFFECTIVE ?? "").trim();
  if (raw === cachedOverrideRaw) return cachedEffectiveDate;
  if (!raw) {
    cachedOverrideRaw = raw;
    cachedEffectiveDate = MAIN_BOARD_ST_RATE_EFFECTIVE;
    return cachedEffectiveDate;
  }
  const valid = strictIsoDate(raw);
  cachedOverrideRaw = raw;
  if (valid) {
    cachedEffectiveDate = valid;
    return cachedEffectiveDate;
  }
  if (!warnedOverrideValues.has(raw)) {
    warnedOverrideValues.add(raw);
    console.warn(`[price-limit-rules] 忽略非法的 ASTOCK_MAIN_BOARD_ST_RATE_EFFECTIVE=${raw}（仅接受 YYYY-MM-DD），回退默认 ${MAIN_BOARD_ST_RATE_EFFECTIVE}`);
  }
  cachedEffectiveDate = MAIN_BOARD_ST_RATE_EFFECTIVE;
  return cachedEffectiveDate;
}

function currentShanghaiDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(new Date());
}

function normalizeRuleDate(value) {
  const digits = String(value || "").replace(/\D/g, "");
  if (digits.length !== 8) return "";
  const date = `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`;
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date
    ? date
    : "";
}

function isBseAshareCode(code) {
  return /^(?:(?:43|83|87|88)\d{4}|920\d{3})$/.test(String(code || "").trim());
}

function priceLimitRate(code, name = "", date, isST) {
  const normalizedCode = String(code || "").trim();
  const ruleDate = normalizeRuleDate(date) || currentShanghaiDate();
  const riskWarning = typeof isST === "boolean"
    ? isST
    : /\*?ST/i.test(String(name || ""));

  if (/^68[89]\d{3}$/.test(normalizedCode)) return 0.2;
  if (/^30[012]\d{3}$/.test(normalizedCode)) {
    if (ruleDate >= CHINEXT_RATE_EFFECTIVE) return 0.2;
    return riskWarning ? 0.05 : 0.1;
  }
  if (isBseAshareCode(normalizedCode)) return 0.3;
  if (riskWarning && ruleDate < mainBoardStRateEffective()) return 0.05;
  return 0.1;
}

function roundPrice(value) {
  return Math.round(value * 100 + 1e-7) / 100;
}

function numericPrice(value) {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : null;
}

// E-07：preClose 字段「存在但不可用」（null / 空串 / 0 / 非数字）时必须回退到
// 调用方传入的昨收，否则涨跌停价直接算不出来、涨停识别静默失效。两者都不可用时
// 返回 null（而不是 0），让上层显式看到「算不出」而不是拿 0 当真值比较。
function resolvePreviousClose(previousClose, current) {
  const own = current && Object.hasOwn(current, "preClose") ? numericPrice(current.preClose) : null;
  if (own !== null) return own;
  return numericPrice(previousClose);
}

function upperLimitPrice(previousClose, current, code, name = "") {
  if (!current || current.noPriceLimit === true || /^[NC]/i.test(String(current.name ?? name).trim())) return null;
  const previous = resolvePreviousClose(previousClose, current);
  if (previous === null) return null;
  if (Object.hasOwn(current, "upperLimit")) return numericPrice(current.upperLimit);
  return roundPrice(previous * (1 + priceLimitRate(code, name, current.date, current.isST)));
}

function isLimitUpPrice(price, target) {
  const current = numericPrice(price);
  const limit = numericPrice(target);
  return current !== null && limit !== null && Math.abs(current - limit) < 0.005;
}

function isLimitUpBar(previousClose, current, code, name = "") {
  const target = upperLimitPrice(previousClose, current, code, name);
  const high = numericPrice(current?.high);
  return target !== null &&
    high !== null &&
    isLimitUpPrice(current?.close, target) &&
    high >= target - 0.005 &&
    high <= target + 0.005;
}

function isOnePriceLimitUpEntry(previousClose, entry, code, name = "") {
  if (!entry) return false;
  const target = upperLimitPrice(previousClose, entry, code, name);
  const high = numericPrice(entry.high);
  const low = numericPrice(entry.low);
  return target !== null &&
    high !== null &&
    low !== null &&
    isLimitUpPrice(high, target) &&
    isLimitUpPrice(low, target) &&
    Math.abs(high - low) < 0.001;
}

function lowerLimitPrice(previousClose, current, code, name = "") {
  if (!current || current.noPriceLimit === true || /^[NC]/i.test(String(current.name ?? name).trim())) return null;
  const previous = resolvePreviousClose(previousClose, current);
  if (previous === null) return null;
  if (Object.hasOwn(current, "lowerLimit")) return numericPrice(current.lowerLimit);
  return roundPrice(previous * (1 - priceLimitRate(code, name, current.date, current.isST)));
}

function isOpeningLimitUpEntry(previousClose, entry, code, name = "") {
  const target = upperLimitPrice(previousClose, entry, code, name);
  const open = numericPrice(entry?.open);
  return target !== null && open !== null && open >= target - 0.005;
}

function isClosingLimitDownExit(previousClose, exit, code, name = "") {
  const target = lowerLimitPrice(previousClose, exit, code, name);
  const close = numericPrice(exit?.close);
  return target !== null && close !== null && close <= target + 0.005;
}

module.exports = {
  CHINEXT_RATE_EFFECTIVE,
  DEFAULT_MAIN_BOARD_ST_RATE_EFFECTIVE,
  mainBoardStRateEffective,
  isBseAshareCode,
  isOpeningLimitUpEntry,
  isClosingLimitDownExit,
  lowerLimitPrice,
  MAIN_BOARD_ST_RATE_EFFECTIVE,
  isLimitUpBar,
  isLimitUpPrice,
  isOnePriceLimitUpEntry,
  priceLimitRate,
  roundPrice,
  upperLimitPrice
};
