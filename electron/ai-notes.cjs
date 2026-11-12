"use strict";

/**
 * 随心记「AI 整理」（1.6.66）：把随手写的一段话交给模型，识别提醒时间、重复、股票代码和价格条件，
 * 并给出一句整理后的待办。只发这段文字和当前时间/交易日，不发持仓、账户或密钥。
 * 输出逐字段校验：时间必须是 YYYY-MM-DD HH:mm，股票必须是 6 位代码，条件必须是价格或涨跌幅；不合格的字段丢弃。
 */
const SYSTEM = `你是 A 股交易者的记事助手。用户随手写了一段话，你要从中识别：
1. 什么时候提醒（北京时间）。A 股交易时段：集合竞价 09:15–09:25，开盘 09:30，上午收盘 11:30，下午开盘 13:00，尾盘约 14:45，收盘 15:00。
   「开盘前」用 09:15，「开盘」用 09:30，「尾盘」用 14:45，「收盘后」用 15:05。说到交易时段、但那天不是交易日时，顺延到下一个交易日（只能从给出的交易日列表里选）。
   没写任何时间、也没写价格条件时，when 填 null。
2. 是否重复：none / tradingDays（每个交易日）/ daily / weekly。
3. 提到的 A 股：只填 6 位代码；只写了名称时，只有在你非常确定代码时才填，否则 null。
4. 价格条件（盘中满足就提醒）：只识别具体数字，例如「跌破 10.2」→ {"field":"latest","op":"lte","value":10.2}；「涨到 1500」→ {"field":"latest","op":"gte","value":1500}；
   「涨幅超过 5%」→ {"field":"changePct","op":"gte","value":5}；「跌超 3%」→ {"field":"changePct","op":"lte","value":-3}。
   「跌破 5 日线」「跌破均价线」「放量」这类没有具体数字的，condition 填 null，写进 note。
5. text：把这件事整理成一句清楚的待办（保留原意、价格和操作，不加你自己的建议，不超过 80 字）。
6. note：你没法变成时间或条件的部分（例如「跌破均价线」要人看），一句话说明；没有就空字符串。
只输出 JSON：{"text":"...","when":"YYYY-MM-DD HH:mm"|null,"repeat":"none","code":"600519"|null,"condition":{...}|null,"note":""}`;

const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);

function sanitize(result, { tradingDays = [] } = {}) {
  const out = { text: clip(result?.text, 120), when: null, repeat: "none", code: null, condition: null, note: clip(result?.note, 120) };
  const when = String(result?.when || "");
  if (/^\d{4}-\d{2}-\d{2} ([01]\d|2[0-3]):[0-5]\d$/.test(when)) out.when = when;
  if (["tradingDays", "daily", "weekly"].includes(result?.repeat)) out.repeat = result.repeat;
  const code = String(result?.code || "");
  if (/^[03689]\d{5}$/.test(code)) out.code = code;
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

function createNoteParser({ ai }) {
  async function parseNote({ text, now, tradingDays } = {}, { signal } = {}) {
    const request = clip(text, 600);
    if (!request) throw Object.assign(new Error("先写点内容再让 AI 整理"), { code: "AI_NO_INPUT" });
    const days = (Array.isArray(tradingDays) ? tradingDays : []).map(String).filter(day => /^\d{4}-\d{2}-\d{2}$/.test(day)).slice(0, 15);
    const nowText = clip(now, 40);
    const user = `现在是北京时间 ${nowText}。接下来的交易日：${days.join("、") || "未知"}。\n用户写的：${request}`;
    const result = await ai.chat({ system: SYSTEM, user, json: true, temperature: 0.1, maxTokens: 600, signal });
    return { ...sanitize(result, { tradingDays: days }), model: ai.model?.() || "" };
  }
  return { parseNote };
}

module.exports = { createNoteParser, sanitizeNoteParse: sanitize };
