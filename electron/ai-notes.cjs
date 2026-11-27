"use strict";

/**
 * 随心记「AI 整理」（1.6.66）：把随手写的一段话交给模型，识别提醒时间、重复、股票代码和价格条件，
 * 并给出一句整理后的待办。只发这段文字和当前时间/交易日，不发持仓、账户或密钥。
 * 输出逐字段校验：时间必须是 YYYY-MM-DD HH:mm，股票必须是 6 位代码，条件必须是价格或涨跌幅；不合格的字段丢弃。
 */
const SYSTEM = `你是 A 股交易者的记事助手。用户随手写了一段话，你要从中识别：
1. 什么时候提醒（北京时间）。A 股交易时段：集合竞价 09:15–09:25，开盘 09:30，上午收盘 11:30，下午开盘 13:00，尾盘约 14:45，收盘 15:00。
   「开盘前」用 09:15，「开盘」用 09:30，「尾盘」用 14:45，「收盘后」用 15:05。明确写了偏移量时，以实际时刻加减，例如「开盘前半小时」是 09:00，「收盘后十五分钟」是 15:15。说到交易时段、但那天不是交易日时，顺延到下一个交易日（只能从给出的交易日列表里选）。
   没写任何时间、也没写价格条件时，when 填 null。
2. 是否重复：none / tradingDays（每个交易日）/ daily / weekly。
3. 提到的 A 股：只填 6 位代码；只写了名称时，只有在你非常确定代码时才填，否则填 null 并把识别出的股票/简称填到 stockName（例如 "比亚迪"）。
4. 价格条件（盘中满足就提醒）：只识别具体数字，例如「跌破 10.2」→ {"field":"latest","op":"lte","value":10.2}；「涨到 1500」→ {"field":"latest","op":"gte","value":1500}；
   「涨幅超过 5%」→ {"field":"changePct","op":"gte","value":5}；「跌超 3%」→ {"field":"changePct","op":"lte","value":-3}。
   「跌破 5 日线」「跌破均价线」「放量」这类没有具体数字的，condition 填 null，写进 note。
5. text：把这件事整理成一句清楚的待办（保留原意、价格和操作，不加你自己的建议，不超过 80 字）。
6. note：你没法变成时间或条件的部分（例如「跌破均价线」要人看），一句话说明；没有就空字符串。
7. sessionOnly：这件事只有在交易时段（9:30–11:30、13:00–15:00）才有意义时填 true，例如盘中做T、高抛低吸、盯盘口/分时、打板、冲高减仓；
   盘前准备、收盘后复盘、看公告研报、周末计划填 false。拿不准填 false。
只输出 JSON：{"text":"...","when":"YYYY-MM-DD HH:mm"|null,"repeat":"none","code":"600519"|null,"stockName":null,"condition":{...}|null,"note":"","sessionOnly":false}`;

const _priceLimitRules = require("./price-limit-rules.cjs");
const isAStockCode = typeof _priceLimitRules.isAStockCode === "function"
  ? _priceLimitRules.isAStockCode
  : (code = "") => {
      const value = String(code).trim();
      return /^(?:00[0-3]|30[012]|60[0135]|68[89])\d{3}$/.test(value) || _priceLimitRules.isBseAshareCode(value);
    };

const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

const isSupportedNoteCode = raw => {
  const code = String(raw || "").trim();
  return isAStockCode(code) || /^(?:5\d{5}|159\d{3}|1[12]\d{4})$/.test(code);
};
const STOP_PHRASES = /^(?:明早|明天|今天|盘前|盘中|开盘|午盘|尾盘|收盘|关注|买入|卖出|减仓|加仓|清仓|跌破|涨到|涨幅|跌幅|超过|低于|高于|提醒|瞅一眼|看下|一下)$/;

function stockNameCandidates(result, outText, rawText) {
  const candidates = [];
  const seen = new Set();
  const push = (token, explicit = false) => {
    const clean = clip(token, 16);
    if (!clean || clean.length < 2 || STOP_PHRASES.test(clean) || seen.has(clean)) return;
    seen.add(clean);
    candidates.push({ name: clean, explicit });
  };
  if (result?.stockName) push(result.stockName, true);
  const combined = `${outText || ""} ${rawText || ""}`;
  for (const seg of combined.match(/[\u4e00-\u9fa5]{2,6}/g) || []) {
    const trimmed = seg.replace(/(?:明日|明早|明天|今天|早盘|开盘|尾盘|收盘|盘中|跌破|涨到|减仓|加仓|关注|盯紧|买点|卖点)/g, "").trim();
    if (trimmed.length >= 2) push(trimmed, false);
  }
  return candidates.slice(0, 3);
}

async function fallbackResolveCode(resolveStock, candidates) {
  if (typeof resolveStock !== "function" || !candidates.length) return null;
  for (const entry of candidates) {
    const candidate = typeof entry === "string" ? entry : entry.name;
    const explicit = typeof entry === "object" && entry?.explicit === true;
    try {
      const hit = await resolveStock(candidate);
      const list = Array.isArray(hit) ? hit : hit ? [hit] : [];
      const exact = list.find(item => item?.name === candidate && isSupportedNoteCode(item?.code));
      if (exact) return String(exact.code).trim();
      if (explicit) {
        const first = list.find(item => {
          const itemName = String(item?.name || "").trim();
          return isSupportedNoteCode(item?.code) && itemName && (itemName.includes(candidate) || candidate.includes(itemName));
        });
        if (first) return String(first.code).trim();
      }
    } catch { /* 行情联想失败时保持原字段，不影响保存或整理 */ }
  }
  return null;
}

function sanitize(result, { tradingDays = [] } = {}) {
  const out = { text: clip(result?.text, 120), when: null, repeat: "none", code: null, condition: null, note: clip(result?.note, 120) };
  const when = String(result?.when || "");
  if (/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(when)) {
    const date = when.slice(0, 10);
    const midnight = Date.parse(`${date}T00:00:00Z`);
    if (Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === date) out.when = when;
  }
  if (["tradingDays", "daily", "weekly"].includes(result?.repeat)) out.repeat = result.repeat;
  if (typeof result?.sessionOnly === "boolean") out.sessionOnly = result.sessionOnly;
  const code = String(result?.code || "").trim();
  if (isSupportedNoteCode(code)) out.code = code;
  const c = result?.condition;
  if (c && typeof c === "object") {
    const value = Number(c.value);
    const field = c.field === "changePct" ? "changePct" : c.field === "latest" ? "latest" : null;
    const op = c.op === "lte" || c.op === "gte" ? c.op : null;
    if (field && op && Number.isFinite(value) && (field === "latest" ? value > 0 && value < 100000 : Math.abs(value) <= 30 && value !== 0)) out.condition = { field, op, value };
  }
  // 交易时段说法落到非交易日时，模型偶尔会忽略顺延：时间在交易时段内、日期不在交易日列表里，就丢掉日期让用户自己选。
  if (out.when && tradingDays.length) {
    const [date, hm] = out.when.split(" ");
    const minute = Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
    if (minute >= 9 * 60 + 15 && minute <= 15 * 60 + 5 && date <= tradingDays.at(-1) && !tradingDays.includes(date)) out.when = null;
  }
  return out;
}

function createNoteParser({ ai, resolveStock = null }) {
  async function parseNote({ text, now, tradingDays } = {}, { signal } = {}) {
    const request = clip(text, 600);
    if (!request) throw Object.assign(new Error("先写点内容再让 AI 整理"), { code: "AI_NO_INPUT" });
    const days = (Array.isArray(tradingDays) ? tradingDays : []).map(String).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).slice(0, 15);
    const nowText = clip(now, 40);
    const user = `现在是北京时间 ${nowText}。接下来的交易日：${days.join("、") || "未知"}。\n用户写的：${request}`;
    const result = await ai.chat({ system: SYSTEM, user, json: true, temperature: 0.1, maxTokens: 600, signal });
    const out = sanitize(result, { tradingDays: days });
    if (!out.code && resolveStock) {
      const resolved = await fallbackResolveCode(resolveStock, stockNameCandidates(result, out.text, request));
      if (resolved) out.code = resolved;
    }
    return { ...out, model: ai.model?.() || "" };
  }
  return { parseNote };
}

module.exports = { createNoteParser, sanitizeNoteParse: sanitize };
