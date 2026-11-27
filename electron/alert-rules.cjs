"use strict";

/**
 * 指标预警（技术指标 + 整组套用 + 大盘红绿灯）。和「自选监控」里每只股票的价格条件并行：
 * 那边盯实时报价，这里按**已收盘的日线**判断指标的「刚刚发生」。设计参考 daily_stock_analysis 的告警中心（MIT）。
 *
 * - 规则类型：收盘价上穿/下穿均线、RSI 上穿/下穿阈值、MACD 金叉/死叉、KDJ 金叉/死叉、CCI 上穿/下穿阈值、大盘红绿灯。
 * - 边缘触发：只比较最近两根已收盘日线——昨天不满足、今天满足才算触发；一直满足不会每天重复报。
 *   盘中（15:05 前）当天那根未收盘的 K 线丢掉不用。
 * - 范围：单只股票、全部自选、全部持仓（一条规则套一组，名单每次评估时现取）、大盘。
 * - 冷却：同一条规则对同一只股票触发后，cooldownHours 内不再报（默认 24 小时）。
 * - 历史：只记「触发」和「数据不够 / 取不到」，正常没触发不记；最多保留 300 条。
 * - 样本不够或日线取不到时记为「数据不足」，不当成没触发，也不发通知。
 */

const TYPES = Object.freeze({
  ma_cross: { label: "收盘价穿均线", directions: ["above", "below"] },
  rsi: { label: "RSI 穿阈值", directions: ["above", "below"] },
  macd: { label: "MACD 金叉/死叉", directions: ["bullish", "bearish"] },
  kdj: { label: "KDJ 金叉/死叉", directions: ["bullish", "bearish"] },
  cci: { label: "CCI 穿阈值", directions: ["above", "below"] },
  market_light: { label: "大盘红绿灯", directions: [] }
});
const SCOPES = Object.freeze(["symbol", "watchlist", "holdings", "market"]);
const MAX_RULES = 60;
const MAX_HISTORY = 300;
const MAX_TARGETS = 100;

const finite = value => { const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN; return Number.isFinite(n) ? n : null; };
const intIn = (value, low, high, fallback) => { const n = finite(value); return n !== null && Number.isInteger(n) && n >= low && n <= high ? n : fallback; };
const clip = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
const cnParts = ms => { const d = new Date(ms + 8 * 3600_000); return { date: d.toISOString().slice(0, 10), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() }; };

// ---------- 指标（纯函数，输入升序的已收盘日线） ----------

const ema = (values, period) => { const k = 2 / (period + 1); const out = []; let prev = null; for (const value of values) { prev = prev === null ? value : value * k + prev * (1 - k); out.push(prev); } return out; };
const sma = (values, period) => values.map((_, index) => index + 1 < period ? null : values.slice(index + 1 - period, index + 1).reduce((a, b) => a + b, 0) / period);

/** Wilder RSI：先用前 period 个涨跌幅的简单均值起算，再按 (avg×(period−1)+当前)/period 递推。预热期为 null。 */
function rsi(closes, period) {
  const out = closes.map(() => null);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i += 1) { const diff = closes[i] - closes[i - 1]; if (diff >= 0) gain += diff; else loss -= diff; }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i += 1) {
    const diff = closes[i] - closes[i - 1];
    gain = (gain * (period - 1) + Math.max(diff, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-diff, 0)) / period;
    out[i] = loss === 0 ? (gain === 0 ? 50 : 100) : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

function macdDiff(closes, fast = 12, slow = 26, signal = 9) {
  const slowLine = ema(closes, slow);
  const dif = ema(closes, fast).map((value, index) => value - slowLine[index]);
  const dea = ema(dif, signal);
  return dif.map((value, index) => value - dea[index]);
}

function kdjDiff(rows, period = 9, kPeriod = 3, dPeriod = 3) {
  let k = 50, d = 50;
  return rows.map((row, index) => {
    if (index + 1 < period) return null;
    const window = rows.slice(index + 1 - period, index + 1);
    const high = Math.max(...window.map(item => item.high)), low = Math.min(...window.map(item => item.low));
    const rsv = high === low ? 50 : (row.close - low) / (high - low) * 100;
    k = (k * (kPeriod - 1) + rsv) / kPeriod;
    d = (d * (dPeriod - 1) + k) / dPeriod;
    return k - d;
  });
}

function cci(rows, period = 14) {
  const tp = rows.map(row => (row.high + row.low + row.close) / 3);
  return tp.map((value, index) => {
    if (index + 1 < period) return null;
    const window = tp.slice(index + 1 - period, index + 1);
    const mean = window.reduce((a, b) => a + b, 0) / period;
    const dev = window.reduce((a, b) => a + Math.abs(b - mean), 0) / period;
    return dev === 0 ? 0 : (value - mean) / (0.015 * dev);
  });
}

/** 每种规则最少需要的已收盘日线数。 */
function requiredBars(rule) {
  const p = rule.params || {};
  if (rule.type === "ma_cross") return p.window + 1;
  if (rule.type === "rsi") return p.period + 2;
  if (rule.type === "macd") return 26 + 9 + 30; // EMA 需要一段预热才稳定
  if (rule.type === "kdj") return 9 + 3 + 3 + 10;
  if (rule.type === "cci") return p.period + 1;
  return 0;
}

const crossUp = (prev, current, threshold) => prev !== null && current !== null && prev <= threshold && current > threshold;
const crossDown = (prev, current, threshold) => prev !== null && current !== null && prev >= threshold && current < threshold;

/**
 * 对一只股票评估一条指标规则。rows：已收盘日线（升序）。
 * 返回 { status: "triggered" | "not_triggered" | "degraded", detail, observed, date }。
 */
function evaluateIndicator(rule, rows) {
  const byDate = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    const date = String(row?.date || "").slice(0, 10);
    const close = finite(row?.close), high = finite(row?.high), low = finite(row?.low);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || close === null || close <= 0 || high === null || high <= 0 || low === null || low <= 0) continue;
    byDate.set(date, { date, close, high, low });
  }
  const bars = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  const need = requiredBars(rule);
  if (bars.length < need) return { status: "degraded", detail: `日线只有 ${bars.length} 根，至少需要 ${need} 根`, observed: null, date: bars.at(-1)?.date || "" };
  const closes = bars.map(row => row.close);
  const last = bars.length - 1;
  const p = rule.params;
  const dir = p.direction;
  const date = bars[last].date;
  const fmt = value => Number(value.toFixed(2));
  if (rule.type === "ma_cross") {
    const ma = sma(closes, p.window);
    const prev = closes[last - 1] - ma[last - 1], current = closes[last] - ma[last];
    const hit = dir === "above" ? crossUp(prev, current, 0) : crossDown(prev, current, 0);
    return { status: hit ? "triggered" : "not_triggered", observed: fmt(closes[last]), date,
      detail: `收盘 ${fmt(closes[last])}${hit ? (dir === "above" ? " 上穿 " : " 跌破 ") : "，"}${p.window} 日线 ${fmt(ma[last])}` };
  }
  if (rule.type === "rsi") {
    const series = rsi(closes, p.period);
    const hit = dir === "above" ? crossUp(series[last - 1], series[last], p.threshold) : crossDown(series[last - 1], series[last], p.threshold);
    return { status: hit ? "triggered" : "not_triggered", observed: fmt(series[last]), date, detail: `RSI(${p.period}) ${fmt(series[last - 1])} → ${fmt(series[last])}${hit ? `，${dir === "above" ? "上穿" : "下穿"} ${p.threshold}` : ""}` };
  }
  if (rule.type === "macd" || rule.type === "kdj") {
    const series = rule.type === "macd" ? macdDiff(closes) : kdjDiff(bars);
    const hit = dir === "bullish" ? crossUp(series[last - 1], series[last], 0) : crossDown(series[last - 1], series[last], 0);
    const name = rule.type === "macd" ? "MACD" : "KDJ";
    return { status: hit ? "triggered" : "not_triggered", observed: fmt(series[last]), date, detail: hit ? `${name} ${dir === "bullish" ? "金叉" : "死叉"}（差值 ${fmt(series[last - 1])} → ${fmt(series[last])}）` : `${name} 差值 ${fmt(series[last])}，没有新的交叉` };
  }
  if (rule.type === "cci") {
    const series = cci(bars, p.period);
    const hit = dir === "above" ? crossUp(series[last - 1], series[last], p.threshold) : crossDown(series[last - 1], series[last], p.threshold);
    return { status: hit ? "triggered" : "not_triggered", observed: fmt(series[last]), date, detail: `CCI(${p.period}) ${fmt(series[last - 1])} → ${fmt(series[last])}${hit ? `，${dir === "above" ? "上穿" : "下穿"} ${p.threshold}` : ""}` };
  }
  return { status: "degraded", detail: "不支持的规则类型", observed: null, date };
}

/**
 * 大盘红绿灯：指数涨跌（50%）+ 涨跌家数（50%）合成 0–100 分；≥60 绿、40–60 黄、<40 红。
 * 任一项缺失就只用另一项并标注；两项都缺返回 null（不判断）。
 */
function marketLight(board) {
  const indices = (board?.indices || []).filter(item => ["000001", "399001", "399006", "000300"].includes(item.code) && finite(item.changePct) !== null);
  const totals = board?.totals;
  const indexScore = indices.length ? Math.max(0, Math.min(100, 50 + indices.reduce((sum, item) => sum + item.changePct, 0) / indices.length * 20)) : null;
  const up = finite(totals?.up), down = finite(totals?.down);
  const breadthScore = up !== null && down !== null && up + down > 0 ? up / (up + down) * 100 : null;
  const parts = [indexScore, breadthScore].filter(value => value !== null);
  if (!parts.length) return null;
  const score = Math.round(parts.reduce((a, b) => a + b, 0) / parts.length);
  const status = score >= 60 ? "green" : score >= 40 ? "yellow" : "red";
  return { score, status, label: { green: "绿灯", yellow: "黄灯", red: "红灯" }[status], partial: parts.length < 2, tradingDate: String(board?.tradingDate || ""),
    detail: `指数平均 ${indices.length ? `${(indices.reduce((sum, item) => sum + item.changePct, 0) / indices.length).toFixed(2)}%` : "未取到"}，上涨 ${up ?? "--"} / 下跌 ${down ?? "--"}` };
}

function normalizeRule(raw, { id } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw Object.assign(new Error("规则格式不对"), { code: "ALERT_INVALID" });
  const type = Object.hasOwn(TYPES, raw.type) ? raw.type : null;
  if (!type) throw Object.assign(new Error("不支持的规则类型"), { code: "ALERT_INVALID" });
  const scope = type === "market_light" ? "market" : SCOPES.includes(raw.scope) && raw.scope !== "market" ? raw.scope : null;
  if (!scope) throw Object.assign(new Error("请选择规则套用的范围"), { code: "ALERT_INVALID" });
  const code = scope === "symbol" ? String(raw.code || "") : "";
  if (scope === "symbol" && !/^\d{6}$/.test(code)) throw Object.assign(new Error("请填写 6 位股票代码"), { code: "ALERT_INVALID" });
  const input = raw.params && typeof raw.params === "object" ? raw.params : {};
  const direction = TYPES[type].directions.includes(input.direction) ? input.direction : TYPES[type].directions[0];
  let params;
  if (type === "ma_cross") params = { direction, window: intIn(input.window, 2, 250, 20) };
  else if (type === "rsi") {
    const threshold = finite(input.threshold);
    if (threshold === null || threshold <= 0 || threshold >= 100) throw Object.assign(new Error("RSI 阈值要在 0 到 100 之间"), { code: "ALERT_INVALID" });
    params = { direction, period: intIn(input.period, 2, 60, 12), threshold };
  } else if (type === "cci") {
    const threshold = finite(input.threshold);
    if (threshold === null || Math.abs(threshold) > 500) throw Object.assign(new Error("CCI 阈值不对"), { code: "ALERT_INVALID" });
    params = { direction, period: intIn(input.period, 2, 60, 14), threshold };
  } else if (type === "market_light") {
    const statuses = (Array.isArray(input.statuses) ? input.statuses : ["red", "yellow"]).filter(item => item === "red" || item === "yellow");
    params = { statuses: statuses.length ? [...new Set(statuses)] : ["red"] };
  } else params = { direction };
  return { id: id || String(raw.id || ""), type, scope, code, name: clip(raw.name, 16), params, enabled: raw.enabled !== false,
    cooldownHours: intIn(raw.cooldownHours, 0, 240, 24), createdAt: typeof raw.createdAt === "string" ? raw.createdAt : "" };
}

function describeRule(rule) {
  const p = rule.params;
  const scope = { symbol: rule.name ? `${rule.name} ${rule.code}` : rule.code, watchlist: "全部自选", holdings: "全部持仓", market: "大盘" }[rule.scope];
  const what = rule.type === "ma_cross" ? `收盘价${p.direction === "above" ? "上穿" : "跌破"} ${p.window} 日线`
    : rule.type === "rsi" ? `RSI(${p.period}) ${p.direction === "above" ? "上穿" : "下穿"} ${p.threshold}`
      : rule.type === "macd" ? `MACD ${p.direction === "bullish" ? "金叉" : "死叉"}`
        : rule.type === "kdj" ? `KDJ ${p.direction === "bullish" ? "金叉" : "死叉"}`
          : rule.type === "cci" ? `CCI(${p.period}) ${p.direction === "above" ? "上穿" : "下穿"} ${p.threshold}`
            : `大盘转${p.statuses.map(item => item === "red" ? "红灯" : "黄灯").join("或")}`;
  return `${scope}：${what}`;
}

const isAlertStoreShape = value => Boolean(value) && typeof value === "object" && !Array.isArray(value) && value.version === 1 && Array.isArray(value.rules) && Array.isArray(value.history);
const isAlertStore = value => isAlertStoreShape(value) && value.rules.length <= MAX_RULES && value.history.length <= MAX_HISTORY;
const isAbortError = (error, signal) => Boolean(signal?.aborted || error?.name === "AbortError" || error?.code === "JOB_CANCELLED" || error?.code === "ABORT_ERR");

function createAlertRules({ store, loadBars, loadTargets, loadBoard, notify = () => {}, now = () => Date.now(), id = () => `ar_${Math.random().toString(36).slice(2, 10)}` } = {}) {
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") throw new TypeError("store is required");
  // 读入时逐条校验规则并截断上限：备份恢复或手改文件里的坏规则直接丢掉，不让整块面板打不开。
  const read = () => {
    const value = store.read();
    if (!isAlertStoreShape(value)) return { version: 1, rules: [], history: [], cooldowns: {}, lastRunAt: "" };
    const rules = value.rules.map(rule => { try { const clean = normalizeRule(rule, { id: String(rule?.id || "") }); return clean.id ? clean : null; } catch { return null; } }).filter(Boolean).slice(0, MAX_RULES);
    return { ...value, rules, history: value.history.filter(item => item && typeof item === "object" && typeof item.at === "string").slice(0, MAX_HISTORY),
      cooldowns: value.cooldowns && typeof value.cooldowns === "object" && !Array.isArray(value.cooldowns) ? value.cooldowns : {} };
  };
  const save = state => {
    state.rules = state.rules.slice(0, MAX_RULES);
    state.history = state.history.slice(0, MAX_HISTORY);
    const activeRuleIds = new Set(state.rules.map(rule => rule.id));
    const cutoff = now() - 30 * 86_400_000;
    const nextCooldowns = {};
    for (const [key, mark] of Object.entries(state.cooldowns || {})) {
      const ruleId = key.split("|")[0];
      if (!activeRuleIds.has(ruleId) || !mark || typeof mark !== "object") continue;
      const until = Number(mark.until || 0);
      const dateMs = typeof mark.date === "string" && mark.date ? Date.parse(`${mark.date}T00:00:00Z`) : NaN;
      if ((Number.isFinite(until) && until >= cutoff) || (Number.isFinite(dateMs) && dateMs >= cutoff)) nextCooldowns[key] = mark;
    }
    state.cooldowns = nextCooldowns;
    store.write(state);
  };
  let running = null;
  let runningMode = "";

  function list() {
    const state = read();
    return { rules: state.rules.map(rule => ({ ...rule, text: describeRule(rule) })), history: state.history, lastRunAt: state.lastRunAt || "", types: Object.fromEntries(Object.entries(TYPES).map(([key, value]) => [key, value.label])) };
  }

  function saveRule(input) {
    const state = read();
    const existing = input?.id ? state.rules.find(rule => rule.id === String(input.id)) : null;
    if (!existing && state.rules.length >= MAX_RULES) throw Object.assign(new Error(`最多 ${MAX_RULES} 条规则`), { code: "ALERT_INVALID" });
    const rule = normalizeRule(input, { id: existing?.id || id() });
    rule.createdAt = existing?.createdAt || new Date(now()).toISOString();
    if (existing) state.rules[state.rules.indexOf(existing)] = rule; else state.rules.unshift(rule);
    save(state);
    return list();
  }

  function removeRule(ruleId) {
    const state = read();
    state.rules = state.rules.filter(rule => rule.id !== String(ruleId || ""));
    for (const key of Object.keys(state.cooldowns || {})) if (key.startsWith(`${ruleId}|`)) delete state.cooldowns[key];
    save(state);
    return list();
  }

  function clearHistory() { const state = read(); state.history = []; save(state); return list(); }

  /** 已收盘的日线：盘中丢掉今天那根。 */
  const closedBars = rows => {
    const { date, minutes } = cnParts(now());
    return (Array.isArray(rows) ? rows : []).filter(row => { const day = String(row?.date || "").slice(0, 10); return day < date || (day === date && minutes >= 15 * 60 + 5); });
  };

  /**
   * 评估所有启用的规则。dryRuleId 给出时只试跑那一条：不写历史、不发通知、不记冷却。
   */
  async function run({ dryRuleId = "", onlyMarket = false, signal } = {}) {
    if (running && !dryRuleId) {
      // 同一种评估正在跑就等它的结果；正在跑的是「只看大盘」而这次要完整评估时，等它跑完再跑完整的。
      if (onlyMarket || runningMode === "full") return running;
      await running.catch(() => undefined);
      if (running) return running;
    }
    const task = (async () => {
      const snapshot = read();
      const rules = snapshot.rules.filter(rule => dryRuleId ? rule.id === dryRuleId : rule.enabled && (!onlyMarket || rule.type === "market_light"));
      const at = now();
      const iso = new Date(at).toISOString();
      const barCache = new Map();
      const barsOf = async target => {
        if (!barCache.has(target.code)) barCache.set(target.code, Promise.resolve().then(() => loadBars(target, { signal })).then(closedBars, error => { if (isAbortError(error, signal)) throw error; return null; }));
        return barCache.get(target.code);
      };
      let targets = null;
      const results = [];
      const notices = [];
      for (const rule of rules) {
        if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("指标预警评估已取消"), { name: "AbortError", code: "JOB_CANCELLED" });
        if (rule.type === "market_light") {
          let light = null;
          try { light = marketLight(await loadBoard({ signal })); } catch (error) { if (isAbortError(error, signal)) throw error; light = null; }
          if (!light) { results.push({ ruleId: rule.id, target: "大盘", code: "", status: "degraded", detail: "大盘数据没取到" }); continue; }
          const hit = rule.params.statuses.includes(light.status);
          // 行情没带交易日时用北京时间的今天，保证「同一天只记一次」的去重始终生效。
          results.push({ ruleId: rule.id, target: "大盘", code: "", status: hit ? "triggered" : "not_triggered", detail: `${light.label}（${light.score} 分）：${light.detail}${light.partial ? "（数据不全）" : ""}`, observed: light.score, date: light.tradingDate || cnParts(at).date });
          continue;
        }
        let list;
        if (rule.scope === "symbol") list = [{ code: rule.code, name: rule.name || rule.code }];
        else {
          if (!targets) { try { targets = await loadTargets(); } catch { targets = { watchlist: [], holdings: [] }; } }
          list = (rule.scope === "watchlist" ? targets.watchlist : targets.holdings) || [];
        }
        const unique = [...new Map(list.filter(item => /^\d{6}$/.test(String(item?.code || ""))).map(item => [item.code, item])).values()];
        if (!unique.length) { results.push({ ruleId: rule.id, target: rule.scope === "watchlist" ? "自选" : "持仓", code: "", status: "degraded", detail: "名单是空的" }); continue; }
        for (const target of unique.slice(0, MAX_TARGETS)) {
          if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("指标预警评估已取消"), { name: "AbortError", code: "JOB_CANCELLED" });
          const rows = await barsOf(target);
          const outcome = rows === null ? { status: "degraded", detail: "日线没取到", observed: null, date: "" } : evaluateIndicator(rule, rows);
          results.push({ ruleId: rule.id, target: target.name || target.code, code: target.code, ...outcome });
        }
        if (unique.length > MAX_TARGETS) results.push({ ruleId: rule.id, target: "名单", code: "", status: "degraded", detail: `名单超过 ${MAX_TARGETS} 只，只评估了前 ${MAX_TARGETS} 只` });
      }
      if (signal?.aborted) throw signal.reason ?? Object.assign(new Error("指标预警评估已取消"), { name: "AbortError", code: "JOB_CANCELLED" });
      if (dryRuleId) return { results, at: iso, dry: true };
      // 评估期间用户可能增删改了规则或清空了历史：重新读最新数据，只往里追加这次的历史、冷却和评估时间。
      const state = read();
      const todayCn = cnParts(at).date;
      const itemDateCn = value => { const ms = Date.parse(value); return Number.isFinite(ms) ? cnParts(ms).date : String(value || "").slice(0, 10); };
      for (const result of results) {
        if (result.status === "not_triggered") continue;
        const rule = state.rules.find(item => item.id === result.ruleId);
        if (!rule) continue; // 评估期间被删掉的规则不再记
        const key = `${result.ruleId}|${result.code || result.target}`;
        const entry = { id: id(), at: iso, ruleId: result.ruleId, ruleText: describeRule(rule), target: result.target, code: result.code, status: result.status, detail: clip(result.detail, 120), date: result.date || "" };
        if (result.status === "triggered") {
          const mark = state.cooldowns[key] || {};
          // 同一根日线（同一天）已经提醒过：重复评估不再记。
          if (mark.date && mark.date === result.date) continue;
          if (Number(mark.until || 0) > at) {
            // 冷却期内的新触发每天只记一条「冷却中」，不动 date，冷却结束后当天仍可正常提醒。
            if (mark.cooldownDate !== result.date) { state.history.unshift({ ...entry, status: "cooldown", detail: `${entry.detail}（冷却中，不重复提醒）` }); state.cooldowns[key] = { ...mark, cooldownDate: result.date }; }
            continue;
          }
          state.cooldowns[key] = { until: at + rule.cooldownHours * 3600_000, date: result.date };
          state.history.unshift(entry);
          notices.push(`${result.target}：${entry.detail}`);
        } else if (!state.history.some(item => item.ruleId === entry.ruleId && item.code === entry.code && item.status === "degraded" && itemDateCn(item.at) === todayCn)) {
          state.history.unshift(entry); // 数据不足每天每只只记一次（按北京日期去重）
        }
      }
      // 只有确实评出过结果（或根本没有启用规则）才算「今天评估过」；全部降级时不算，调度稍后会重试。
      const anyEvaluated = results.length === 0 || results.some(item => item.status !== "degraded");
      if (!onlyMarket && anyEvaluated) state.lastRunAt = iso;
      save(state);
      if (notices.length) {
        try { notify({ title: notices.length === 1 ? "指标预警" : `指标预警：${notices.length} 条触发`, body: notices.slice(0, 6).join("\n").slice(0, 240) }); } catch { /* 通知失败不影响记录 */ }
      }
      return { results, at: iso, dry: false, triggered: notices.length };
    })();
    if (!dryRuleId) {
      runningMode = onlyMarket ? "market" : "full";
      running = task;
      const clearRunning = () => { if (running === task) { running = null; runningMode = ""; } };
      task.then(clearRunning, clearRunning);
    }
    return task;
  }

  return { list, saveRule, removeRule, clearHistory, run };
}

module.exports = { createAlertRules, evaluateIndicator, marketLight, normalizeRule, describeRule, requiredBars, rsi, macdDiff, kdjDiff, cci, isAlertStore };
