"use strict";

/**
 * 随心记的价格条件（1.6.66）：页面把「还在盯」的条件交给主进程，主进程在交易时段每 15 秒取一次报价，
 * 条件满足就记下来并发系统通知（窗口最小化也能收到）；页面下次同步时取走触发记录、弹出提醒卡片。
 * 每个条件只触发一次。只读报价，不下单。
 */
const MAX_ITEMS = 30;
const MAX_HITS = 50;
const CONCURRENCY = 4;

function finite(value) {
  if (typeof value !== "number" && (typeof value !== "string" || !value.trim())) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
const BSE_CODE_PATTERN = /^(?:(?:43|83|87|88)\d{4}|920\d{3})$/;
const SH_CODE_PATTERN = /^(?:6\d{5}|900\d{3}|5\d{5}|11\d{4})$/;
const ETF_CODE_PATTERN = /^(?:5\d{5}|159\d{3})$/;
const CONVERTIBLE_BOND_CODE_PATTERN = /^(?:110|111|113|118|123|125|126|127|128)\d{3}$/;

function defaultSecid(code) {
  if (BSE_CODE_PATTERN.test(code)) return `0.${code}`;
  if (SH_CODE_PATTERN.test(code)) return `1.${code}`;
  return `0.${code}`;
}

function inferAssetType(code, rawAssetType) {
  if (rawAssetType === "stock" || rawAssetType === "etf" || rawAssetType === "convertibleBond") {
    return rawAssetType;
  }
  if (rawAssetType === "bond") return "convertibleBond";
  if (ETF_CODE_PATTERN.test(code)) return "etf";
  if (CONVERTIBLE_BOND_CODE_PATTERN.test(code)) return "convertibleBond";
  return "stock";
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").slice(0, 40);
  const code = String(raw.code || "");
  const condition = raw.condition && typeof raw.condition === "object" ? raw.condition : null;
  if (!id || !/^\d{6}$/.test(code) || !condition) return null;
  const field = condition.field === "changePct" ? "changePct" : condition.field === "latest" ? "latest" : null;
  const op = condition.op === "lte" || condition.op === "gte" ? condition.op : null;
  const value = finite(condition.value);
  if (!field || !op || value === null) return null;
  if (field === "latest" && !(value > 0)) return null;
  const secid = /^[01]\.\d{6}$/.test(String(raw.secid || "")) ? String(raw.secid) : defaultSecid(code);
  const assetType = inferAssetType(code, raw.assetType);
  return { id, code, name: String(raw.name || code).slice(0, 16), secid, assetType, text: String(raw.text || "").slice(0, 80), condition: { field, op, value } };
}

const fmt = (value, digits) => Number(value.toFixed(digits)).toString();

/** 报价是否满足条件；满足时返回说明文字。 */
function evaluateCondition(condition, quote) {
  const actual = finite(condition.field === "latest" ? quote?.latest : quote?.changePct);
  if (actual === null || (condition.field === "latest" && !(actual > 0))) return null;
  const met = condition.op === "lte" ? actual <= condition.value : actual >= condition.value;
  if (!met) return null;
  if (condition.field === "latest") return `现价 ${fmt(actual, 3)}，已${condition.op === "lte" ? "跌到" : "涨到"} ${fmt(condition.value, 3)} ${condition.op === "lte" ? "以下" : "以上"}`;
  return `涨跌幅 ${actual > 0 ? "+" : ""}${fmt(actual, 2)}%，已${condition.op === "gte" ? `涨超 ${fmt(condition.value, 2)}%` : `跌超 ${fmt(Math.abs(condition.value), 2)}%`}`;
}

function sameWatchCondition(left, right) {
  return Boolean(left && right && left.code === right.code && left.secid === right.secid &&
    left.assetType === right.assetType && left.condition.field === right.condition.field &&
    left.condition.op === right.condition.op && left.condition.value === right.condition.value);
}

function createNoteWatcher({ getQuote, notify = () => undefined, inSession, now = () => Date.now(), intervalMs = 15_000,
  setTimer = (fn, ms) => setInterval(fn, ms), clearTimer = id => clearInterval(id) } = {}) {
  let items = [];
  let hits = [];
  let systemNotify = true;
  let timer = null;
  let inflight = null;
  let lastError = "";
  let lastCheckAt = 0;

  const stopTimer = () => { if (timer !== null) { clearTimer(timer); timer = null; } };
  const ensureTimer = () => {
    if (!items.length) { stopTimer(); return; }
    if (timer === null) { timer = setTimer(() => { void tick(); }, intervalMs); timer?.unref?.(); }
  };

  /** 一轮检查；上一轮还没结束时返回同一轮（不并发取报价）。 */
  function tick() {
    if (inflight) return inflight;
    if (!items.length || !inSession(now())) return Promise.resolve();
    inflight = check().finally(() => { inflight = null; });
    return inflight;
  }

  async function check() {
    const submitted = new Map(items.map(item => [item.id, item]));
    const securities = new Map(items.map(item => [`${item.secid}:${item.assetType}`, item]));
    const keys = [...securities.keys()];
    const quotes = new Map();
    let failed = 0;
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, keys.length) }, async () => {
      while (keys.length) {
        const key = keys.shift();
        const { code, name, secid, assetType } = securities.get(key);
        try { const snapshot = await getQuote({ code, name, secid, assetType }); quotes.set(key, snapshot?.quote || null); }
        catch (error) { failed += 1; lastError = String(error?.message || error).slice(0, 120); }
      }
    }));
    if (!failed) lastError = "";
    lastCheckAt = now();
    const fired = [];
    if (!inSession(lastCheckAt)) return;
    for (const item of items) {
      if (!sameWatchCondition(submitted.get(item.id), item)) continue;
      const detail = evaluateCondition(item.condition, quotes.get(`${item.secid}:${item.assetType}`));
      if (detail) fired.push({ item, detail });
    }
    if (!fired.length) return;
    const ids = new Set(fired.map(entry => entry.item.id));
    items = items.filter(item => !ids.has(item.id));
    const at = new Date(now()).toISOString();
    hits = [...hits, ...fired.map(({ item, detail }) => ({ item, at, detail: `${item.name} ${detail}` }))].slice(-MAX_HITS);
    if (systemNotify) {
      const title = fired.length > 1 ? `随心记：${fired.length} 个价格条件到了` : `随心记：${fired[0].item.name} 价格条件到了`;
      const body = fired.map(({ item, detail }) => `${item.name} ${detail}${item.text ? ` — ${item.text}` : ""}`).join("\n").slice(0, 240);
      try { notify({ title, body }); } catch { /* 通知失败不影响记录 */ }
    }
    ensureTimer();
  }

  /** 页面同步：交来当前要盯的条件，取走已触发的记录。 */
  function sync(input = {}) {
    const seen = new Set();
    const submitted = (Array.isArray(input.items) ? input.items : []).map(normalizeItem)
      .filter(item => item && !seen.has(item.id) && seen.add(item.id));
    const byId = new Map(submitted.map(item => [item.id, item]));
    const taken = hits.filter(hit => {
      const current = byId.get(hit.item.id);
      return !current || sameWatchCondition(hit.item, current);
    });
    hits = [];
    const takenIds = new Set(taken.map(hit => hit.item.id));
    items = submitted.filter(item => !takenIds.has(item.id)).slice(0, MAX_ITEMS);
    systemNotify = input.systemNotify !== false;
    ensureTimer();
    if (items.length && inSession(now()) && now() - lastCheckAt > intervalMs) void tick();
    return { hits: taken.map(({ item, at, detail }) => ({ id: item.id, at, detail })), watching: items.length, session: inSession(now()), ...(lastError ? { error: lastError } : {}) };
  }

  return { sync, tick, stop: () => { items = []; stopTimer(); } };
}

/** A 股连续竞价时段（北京时间，交易日 9:30–11:30、13:00–15:00）。 */
function inTradingSession(ms, isTradingDate) {
  const cn = new Date(ms + 8 * 3600_000);
  const date = cn.toISOString().slice(0, 10);
  const minute = cn.getUTCHours() * 60 + cn.getUTCMinutes();
  return isTradingDate(date) && ((minute >= 570 && minute <= 690) || (minute >= 780 && minute <= 900));
}

// 分钟循环由主进程计时，最小化或关闭 macOS 窗口也能通知。
function createIntervalReminderScheduler({
  now = Date.now,
  notify = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let items = new Map();
  let timer = null;
  let systemNotify = true;

  function tick() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    const currentTime = now();
    let nextWake = Infinity;
    const due = [];
    for (const item of items.values()) {
      if (item.nextAt <= currentTime) {
        item.lastFiredAt = item.nextAt;
        item.nextAt += (Math.floor((currentTime - item.nextAt) / item.intervalMs) + 1) * item.intervalMs;
        due.push(item.text);
      }
      nextWake = Math.min(nextWake, item.nextAt);
    }
    if (Number.isFinite(nextWake)) {
      // setTimeout 最长约 24 天。较远的提醒每天醒一次即可。
      timer = setTimer(tick, Math.min(nextWake - currentTime, 86_400_000));
      timer?.unref?.();
    }
    if (due.length && systemNotify) {
      try {
        notify({
          title: due.length === 1 ? "随心记提醒" : `随心记：${due.length} 条提醒到了`,
          body: due.join("\n").slice(0, 240)
        });
      } catch { /* 系统通知失败时仍保留触发记录，交给应用内提醒。 */ }
    }
  }

  function sync(input) {
    systemNotify = input?.systemNotify !== false;
    const next = new Map();
    const submitted = Array.isArray(input?.items) ? input.items.slice(0, 1000) : [];
    for (const raw of submitted) {
      const id = typeof raw?.id === "string" ? raw.id.slice(0, 40) : "";
      const { at, intervalMinutes } = raw || {};
      if (!id || !Number.isSafeInteger(at) || at <= 0 || at > 8.64e15 - 86_400_000 ||
          !Number.isInteger(intervalMinutes) || intervalMinutes < 1 || intervalMinutes > 1440) continue;
      const intervalMs = intervalMinutes * 60_000;
      const text = String(raw.text || "").slice(0, 80);
      const existing = items.get(id);
      // 渲染进程可能在下一次通知后才确认前一次的排程。
      const sameSchedule = existing && existing.intervalMs === intervalMs && (
        existing.at === at || (at >= existing.at && at <= existing.nextAt && (at - existing.at) % intervalMs === 0)
      );
      next.set(id, sameSchedule
        ? { ...existing, text, at, lastFiredAt: existing.lastFiredAt >= at ? existing.lastFiredAt : null }
        : { id, text, at, intervalMs, nextAt: at, lastFiredAt: null });
    }
    items = next;
    tick();
    return [...items.values()].filter(item => item.lastFiredAt !== null)
      .map(({ id, at, lastFiredAt, nextAt }) => ({ id, at, lastFiredAt, nextAt }));
  }

  return { sync, tick, stop() { items.clear(); tick(); } };
}

module.exports = { createNoteWatcher, evaluateCondition, normalizeItem, inTradingSession, createIntervalReminderScheduler };
