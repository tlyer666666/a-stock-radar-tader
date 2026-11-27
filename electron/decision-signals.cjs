"use strict";

/**
 * AI 建议池（决策信号）：把 AI 问股对个股 / ETF 给出的结论沉淀成一条条结构化、可追踪、可事后验证的建议。
 * 设计参考开源项目 daily_stock_analysis 的 DecisionSignal（MIT），按本软件的数据口径重写。
 *
 * - 一条建议 = 动作（买入/加仓/持有/减仓/卖出/观望/回避）+ 周期 + 入场区间 + 止损 + 目标 + 失效条件 + 要盯的条件。
 * - 护栏：买入/加仓必须有止损或失效条件，且价格关系要合理（止损 < 入场 < 目标）；不满足就降级为「观望」并写明原因，
 *   不把没有风控位的建议记成可执行的买入。
 * - 生命周期：active → expired（过了有效期）/ invalidated（同一只股票出了方向相反的新建议）/ closed（用户手动关闭）。
 * - 事后验证：只用日线，建议发出后的第 1 / 3 / 5 / 10 个交易日收盘各评一次——
 *   偏多（买入/加仓/持有）涨 ≥1% 算对、跌 ≥1% 或期间跌破止损算错；偏空（减仓/卖出/回避）相反；其余算持平。观望不评。
 * - 统计：已评样本不到 MIN_SAMPLE 条时不给命中率，只给样本数（样本太少的命中率没有意义）。
 * - 这里只记录和评估，不下单、不调仓。取不到的数保持 null。
 */

const ACTIONS = Object.freeze(["buy", "add", "hold", "reduce", "sell", "watch", "avoid"]);
const ACTION_LABEL = Object.freeze({ buy: "买入", add: "加仓", hold: "持有", reduce: "减仓", sell: "卖出", watch: "观望", avoid: "回避" });
const BULLISH = new Set(["buy", "add", "hold"]);
const BEARISH = new Set(["reduce", "sell", "avoid"]);
const HORIZONS = Object.freeze(["1d", "3d", "5d", "10d", "swing"]);
const HORIZON_LABEL = Object.freeze({ "1d": "1 个交易日", "3d": "3 个交易日", "5d": "5 个交易日", "10d": "10 个交易日", swing: "波段（数周）" });
const HORIZON_DAYS = Object.freeze({ "1d": 1, "3d": 3, "5d": 5, "10d": 10, swing: 20 });
const EVAL_DAYS = Object.freeze([1, 3, 5, 10]);
const HIT_PCT = 1;
const MIN_SAMPLE = 10;
const MAX_SIGNALS = 600;
const DAY_MS = 86_400_000;

const finite = value => {
  const n = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : NaN;
  return Number.isFinite(n) ? n : null;
};
const price = value => { const n = finite(value); return n !== null && n > 0 && n < 1e6 ? Math.round(n * 1000) / 1000 : null; };
const clip = (value, max) => { const text = String(value ?? "").replace(/\s+/g, " ").trim(); return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text; };
const cnDate = ms => Number.isFinite(ms) ? new Date(ms + 8 * 3600_000).toISOString().slice(0, 10) : "";
const cnMinutes = ms => { if (!Number.isFinite(ms)) return NaN; const d = new Date(ms + 8 * 3600_000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
const round2 = value => value === null ? null : Math.round(value * 100) / 100;

/**
 * 校验 AI 给的计划并套护栏。返回 { plan, guardrail }；没有可用动作返回 null。
 * guardrail 不为空表示动作被降级（原动作记在 rawAction 里）。
 */
function normalizePlan(raw, { referencePrice = null } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rawAction = ACTIONS.includes(raw.action) ? raw.action : null;
  if (!rawAction) return null;
  const horizon = HORIZONS.includes(raw.horizon) ? raw.horizon : "5d";
  let entryLow = price(raw.entryLow);
  let entryHigh = price(raw.entryHigh);
  if (entryLow !== null && entryHigh !== null && entryLow > entryHigh) [entryLow, entryHigh] = [entryHigh, entryLow];
  if (entryLow === null) entryLow = entryHigh;
  if (entryHigh === null) entryHigh = entryLow;
  const stopLoss = price(raw.stopLoss);
  const targetPrice = price(raw.targetPrice);
  const invalidation = clip(raw.invalidation, 80);
  const watch = (Array.isArray(raw.watch) ? raw.watch : []).map(item => clip(item, 40)).filter(Boolean).slice(0, 4);
  const reason = clip(raw.reason, 120);
  let action = rawAction;
  let guardrail = "";
  const ref = price(referencePrice);
  if (action === "buy" || action === "add") {
    const stopBase = entryLow ?? ref;
    const targetBase = entryHigh ?? ref;
    const distBase = ref ?? entryLow;
    if (stopLoss === null && !invalidation) guardrail = "没有给出止损价或失效条件，按观望记录";
    else if (stopLoss !== null && stopBase !== null && stopLoss >= stopBase) guardrail = "止损价不低于入场价，价格关系矛盾，按观望记录";
    else if (targetPrice !== null && targetBase !== null && targetPrice <= targetBase) guardrail = "目标价不高于入场价，价格关系矛盾，按观望记录";
    else if (distBase !== null && stopLoss !== null && stopLoss < distBase * 0.7) guardrail = "止损离现价超过 30%，不构成有效风控，按观望记录";
    if (guardrail) action = "watch";
  }
  return {
    plan: { action, horizon, entryLow, entryHigh, stopLoss, targetPrice, invalidation, watch, reason },
    guardrail,
    ...(guardrail ? { rawAction } : {})
  };
}

/** 风险复核否决：买入 / 加仓记成观望，并把否决理由写进护栏说明（其他动作和 pass / downgrade 不改）。 */
function applyRiskReview(normalized, review) {
  if (!normalized || review?.verdict !== "veto" || !["buy", "add"].includes(normalized.plan.action)) return normalized;
  const reasons = (Array.isArray(review.reasons) ? review.reasons : []).map(item => clip(item, 50)).filter(Boolean);
  return { ...normalized, plan: { ...normalized.plan, action: "watch" }, rawAction: normalized.rawAction || normalized.plan.action,
    guardrail: clip(`风险复核否决：${reasons.join("；") || "风险大于收益"}`, 80) };
}

/** 有效期：周期对应的交易日数按 7/5 折成自然日，再多留 1 天；波段 30 天。 */
function expiryOf(createdMs, horizon) {
  const days = HORIZON_DAYS[horizon] || 5;
  return createdMs + (horizon === "swing" ? 30 : Math.ceil(days * 7 / 5) + 1) * DAY_MS;
}

/**
 * 对一条建议做事后验证（纯函数）。bars：按日期升序的日线 { date, close, high, low }。
 * 返回 { [天数]: outcome }，前向 K 线不够的天数不返回（下次再评）。
 */
function evaluateSignal(signal, bars) {
  const rows = (Array.isArray(bars) ? bars : []).filter(row => row && typeof row.date === "string" && finite(row.close) !== null && row.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const createdMs = Date.parse(signal.createdAt);
  const created = cnDate(createdMs);
  if (!created) return {};
  // 开盘前（北京时间 9:30 前）给出的建议，当天就是第 1 个交易日：基准价取前一交易日收盘（不能拿当天收盘，否则首日收益恒为 0%），
  // 当天的最低价要参与止损判断，当天收盘就是 1 日结果。
  // 盘中或收盘后给出的建议从下一个交易日开始算——日线分不清当天的高低点出现在建议之前还是之后。
  const createdMinutes = cnMinutes(createdMs);
  const preOpen = Number.isFinite(createdMs) && createdMinutes < 9 * 60 + 30;
  const base = [...rows].reverse().find(row => preOpen ? row.date < created : row.date <= created);
  const start = price(signal.referencePrice) ?? (base ? price(base.close) : null);
  const stopLoss = price(signal.stopLoss);
  const targetPrice = price(signal.targetPrice);
  const forward = rows.filter(row => preOpen ? row.date >= created : row.date > created);
  const out = {};
  for (const days of EVAL_DAYS) {
    if (signal.outcomes?.[days]) continue;
    if (!BULLISH.has(signal.action) && !BEARISH.has(signal.action)) { out[days] = { status: "unable", reason: "观望类建议不评对错" }; continue; }
    if (start === null) { out[days] = { status: "unable", reason: "没有建议当时的价格" }; continue; }
    if (forward.length < days) continue;
    const window = forward.slice(0, days);
    const end = window.at(-1);
    const returnPct = (end.close / start - 1) * 100;
    const lows = window.map(row => finite(row.low)).filter(value => value !== null && value > 0);
    const highs = window.map(row => finite(row.high)).filter(value => value !== null && value > 0);
    const bullish = BULLISH.has(signal.action);
    const adverse = bullish
      ? lows.length ? Math.max(0, (start - Math.min(...lows)) / start * 100) : null
      : highs.length ? Math.max(0, (Math.max(...highs) - start) / start * 100) : null;
    const stopHit = bullish && stopLoss !== null && lows.some(low => low <= stopLoss);
    const targetHit = bullish && targetPrice !== null && highs.some(high => high >= targetPrice);
    const directional = bullish ? returnPct : -returnPct;
    const verdict = stopHit ? "miss" : directional >= HIT_PCT ? "hit" : directional <= -HIT_PCT ? "miss" : "neutral";
    out[days] = { status: "done", verdict, returnPct: round2(returnPct), maxAdversePct: round2(adverse), stopHit, targetHit, endDate: end.date, endClose: price(end.close), startPrice: start };
  }
  return out;
}

/** 一组已评结果的统计；样本不足不出比率。 */
function summarize(outcomes) {
  const done = outcomes.filter(item => item.status === "done");
  const hit = done.filter(item => item.verdict === "hit").length;
  const miss = done.filter(item => item.verdict === "miss").length;
  const enough = done.length >= MIN_SAMPLE;
  const returns = done.map(item => item.returnPct).filter(value => value !== null);
  const adverse = done.map(item => item.maxAdversePct).filter(value => value !== null);
  return {
    total: outcomes.length, completed: done.length, hit, miss, neutral: done.length - hit - miss, unable: outcomes.length - done.length,
    enough, minSample: MIN_SAMPLE,
    hitRatePct: enough && hit + miss > 0 ? round2(hit / (hit + miss) * 100) : null,
    avgReturnPct: enough && returns.length ? round2(returns.reduce((a, b) => a + b, 0) / returns.length) : null,
    maxAdversePct: enough && adverse.length ? round2(Math.max(...adverse)) : null
  };
}

const isSignalStore = value => Boolean(value) && typeof value === "object" && !Array.isArray(value) && value.version === 1 && Array.isArray(value.signals);

function createDecisionSignals({ store, loadBars = null, now = () => Date.now(), id = () => `sig_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}` } = {}) {
  if (!store || typeof store.read !== "function" || typeof store.write !== "function") throw new TypeError("store is required");
  // 读入时校验时间戳并补齐字段：备份恢复或旧版本写的记录缺数组字段或时间损坏时不能让界面崩。
  const tidy = item => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    if (!/^\d{6}$/.test(String(item.code)) || !ACTIONS.includes(item.action)) return null;
    const createdMs = typeof item.createdAt === "string" ? Date.parse(item.createdAt) : NaN;
    if (!Number.isFinite(createdMs)) return null;
    const horizon = HORIZONS.includes(item.horizon) ? item.horizon : "5d";
    const expiresMs = typeof item.expiresAt === "string" ? Date.parse(item.expiresAt) : NaN;
    const expiresAt = Number.isFinite(expiresMs) ? item.expiresAt : new Date(expiryOf(createdMs, horizon)).toISOString();
    return {
      ...item,
      horizon,
      expiresAt,
      watch: Array.isArray(item.watch) ? item.watch : [],
      outcomes: item.outcomes && typeof item.outcomes === "object" && !Array.isArray(item.outcomes) ? item.outcomes : {},
      source: item.source && typeof item.source === "object" && !Array.isArray(item.source)
        ? { conversationId: "", messageId: "", model: "", ...item.source, skills: Array.isArray(item.source.skills) ? item.source.skills : [] }
        : { conversationId: "", messageId: "", model: "", skills: [] }
    };
  };
  const read = () => { const value = store.read(); return isSignalStore(value) ? { ...value, signals: value.signals.map(tidy).filter(Boolean) } : { version: 1, signals: [] }; };
  const save = state => {
    // 超量时优先保留最新的生效中建议，总条数严格封顶 MAX_SIGNALS。
    if (state.signals.length > MAX_SIGNALS) {
      const active = state.signals.filter(item => item.status === "active").sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, MAX_SIGNALS);
      const keep = new Set(active.map(item => item.id));
      const ended = state.signals.filter(item => !keep.has(item.id)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, Math.max(0, MAX_SIGNALS - keep.size));
      const allowed = new Set([...keep, ...ended.map(item => item.id)]);
      state.signals = state.signals.filter(item => allowed.has(item.id)).slice(0, MAX_SIGNALS);
    }
    store.write(state);
  };
  let evaluating = null;
  const expireStale = state => {
    let changed = false;
    for (const signal of state.signals) {
      if (signal.status === "active" && Date.parse(signal.expiresAt) <= now()) { signal.status = "expired"; signal.updatedAt = new Date(now()).toISOString(); changed = true; }
    }
    return changed;
  };

  /**
   * 记一条建议。同一只股票当天同动作同周期的重复建议只刷新不新增；方向相反的新建议会让旧的仍生效建议失效。
   * @returns {{ signal: object, created: boolean } | null}
   */
  function record({ code, name, assetType = "stock", plan, guardrail = "", rawAction = "", stance = "", confidence = "", referencePrice = null, source = {} } = {}) {
    if (!/^\d{6}$/.test(String(code || "")) || !plan || !ACTIONS.includes(plan.action)) return null;
    const state = read();
    expireStale(state);
    const at = now();
    const iso = new Date(at).toISOString();
    const today = cnDate(at);
    const fields = {
      action: plan.action, horizon: plan.horizon, entryLow: plan.entryLow, entryHigh: plan.entryHigh, stopLoss: plan.stopLoss, targetPrice: plan.targetPrice,
      invalidation: plan.invalidation, watch: plan.watch, reason: plan.reason, guardrail: clip(guardrail, 80), ...(rawAction ? { rawAction } : {}),
      stance: clip(stance, 6), confidence: clip(confidence, 4), referencePrice: price(referencePrice),
      source: { conversationId: clip(source.conversationId, 80), messageId: clip(source.messageId, 80), model: clip(source.model, 40), skills: (Array.isArray(source.skills) ? source.skills : []).map(item => clip(item, 12)).slice(0, 3) }
    };
    const same = state.signals.find(item => item.code === code && item.status === "active" && item.action === plan.action && item.horizon === plan.horizon && cnDate(Date.parse(item.createdAt)) === today);
    if (same) {
      Object.assign(same, fields, { referencePrice: same.referencePrice ?? fields.referencePrice, updatedAt: iso });
      if (!rawAction) delete same.rawAction;
      save(state);
      return { signal: same, created: false };
    }
    const bullish = BULLISH.has(plan.action);
    const bearish = BEARISH.has(plan.action);
    for (const old of state.signals) {
      if (old.code !== code || old.status !== "active") continue;
      if ((bullish && BEARISH.has(old.action)) || (bearish && BULLISH.has(old.action))) {
        old.status = "invalidated"; old.updatedAt = iso; old.endedReason = `${today} 出了方向相反的新建议：${ACTION_LABEL[plan.action]}`;
      }
    }
    const signal = { id: id(), code: String(code), name: clip(name || code, 16), assetType: assetType === "etf" || /^(?:5\d{5}|159\d{3})$/.test(String(code)) ? "etf" : "stock", status: "active",
      createdAt: iso, updatedAt: iso, expiresAt: new Date(expiryOf(at, plan.horizon)).toISOString(), ...fields, outcomes: {}, feedback: null };
    state.signals.unshift(signal);
    save(state);
    return { signal, created: true };
  }

  function list({ status = "", code = "", limit = 200 } = {}) {
    const state = read();
    if (expireStale(state)) save(state);
    return state.signals
      .filter(item => (!status || item.status === status) && (!code || item.code === code))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(600, Number(limit) || 200)));
  }

  /** 用户操作：关闭 / 标记失效、反馈有用没用。结束状态不能改回生效。 */
  function update(signalId, patch = {}) {
    const state = read();
    const signal = state.signals.find(item => item.id === String(signalId || ""));
    if (!signal) throw Object.assign(new Error("这条建议已不存在"), { code: "SIGNAL_NOT_FOUND" });
    if (patch.status !== undefined) {
      if (!["closed", "invalidated"].includes(patch.status)) throw Object.assign(new Error("只能把建议关闭或标记为失效"), { code: "SIGNAL_INVALID" });
      if (signal.status === "active") { signal.status = patch.status; signal.endedReason = "手动处理"; }
    }
    if (patch.feedback !== undefined) signal.feedback = patch.feedback === "useful" || patch.feedback === "not_useful" ? patch.feedback : null;
    signal.updatedAt = new Date(now()).toISOString();
    save(state);
    return signal;
  }

  function remove(signalId) {
    const state = read();
    const before = state.signals.length;
    state.signals = state.signals.filter(item => item.id !== String(signalId || ""));
    if (state.signals.length !== before) save(state);
    return { removed: before - state.signals.length };
  }

  /** 给还没评完的建议补事后验证。每只股票只读一次日线；读不到的跳过，下次再试。 */
  async function evaluatePending({ signal: abort } = {}) {
    if (typeof loadBars !== "function") return { evaluated: 0, failed: 0 };
    if (evaluating) {
      if (!abort) return evaluating;
      if (abort.aborted) throw abort.reason ?? Object.assign(new Error("建议验证已取消"), { name: "AbortError" });
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(abort.reason ?? Object.assign(new Error("建议验证已取消"), { name: "AbortError" }));
        abort.addEventListener("abort", onAbort, { once: true });
        evaluating.then(
          value => { abort.removeEventListener("abort", onAbort); resolve(value); },
          error => { abort.removeEventListener("abort", onAbort); reject(error); }
        );
      });
    }
    const task = (async () => {
      const snapshot = read();
      const currentMs = now();
      const cutoff = currentMs - 60 * DAY_MS; // 两个月前的建议不再补评
      // 昨天及以前的建议，或今天盘前（09:30 前）给出且已收盘（15:05 后）的建议，才有可评的交易日；其余不为它们读日线。最老的优先：一次最多 60 只，避免老建议排不上队直到过期。
      const today = cnDate(currentMs);
      const closedToday = cnMinutes(currentMs) >= 15 * 60 + 5;
      const pending = snapshot.signals
        .filter(item => {
          const createdMs = Date.parse(item.createdAt);
          if (!Number.isFinite(createdMs) || createdMs < cutoff) return false;
          if (!EVAL_DAYS.some(days => !item.outcomes?.[days])) return false;
          const createdDate = cnDate(createdMs);
          if (createdDate < today) return true;
          return createdDate === today && closedToday && cnMinutes(createdMs) < 9 * 60 + 30;
        })
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
      const codes = [...new Set(pending.map(item => item.code))].slice(0, 60);
      const updates = new Map(); // id → 新评出的结果
      let failed = 0;
      for (const code of codes) {
        if (abort?.aborted) break;
        let bars;
        try { bars = closedBars(await loadBars({ code, assetType: pending.find(item => item.code === code)?.assetType || "stock" }, { signal: abort })); }
        catch (error) { if (abort?.aborted || error?.name === "AbortError") break; failed += 1; continue; }
        for (const signal of pending.filter(item => item.code === code)) {
          const outcomes = evaluateSignal(signal, bars);
          if (Object.keys(outcomes).length) updates.set(signal.id, outcomes);
        }
      }
      // 读日线期间可能有新建议入库或用户点了关闭 / 反馈：重新读一遍最新数据，只把评分结果按 id 合并进去。
      const state = read();
      const expired = expireStale(state);
      let evaluated = 0;
      for (const signal of state.signals) {
        const outcomes = updates.get(signal.id);
        if (!outcomes) continue;
        signal.outcomes = { ...outcomes, ...(signal.outcomes || {}) };
        signal.evaluatedAt = new Date(now()).toISOString();
        evaluated += 1;
      }
      if (evaluated || expired) save(state);
      return { evaluated, failed };
    })();
    evaluating = task;
    const clearEvaluating = () => { if (evaluating === task) evaluating = null; };
    task.then(clearEvaluating, clearEvaluating);
    return task;
  }

  /** 只用已收盘的日线评分：盘中（15:05 前）丢掉当天那根，否则会用没走完的价格下结论，而且结论不会再改。 */
  function closedBars(rows) {
    const cn = new Date(now() + 8 * 3600_000);
    const today = cn.toISOString().slice(0, 10);
    const closed = cn.getUTCHours() * 60 + cn.getUTCMinutes() >= 15 * 60 + 5;
    return (Array.isArray(rows) ? rows : []).filter(row => { const date = String(row?.date || "").slice(0, 10); return date < today || (date === today && closed); });
  }

  /** 整体表现：按评估天数、按动作分组。 */
  function stats() {
    const signals = read().signals;
    const byDays = {};
    for (const days of EVAL_DAYS) byDays[days] = summarize(signals.map(item => item.outcomes?.[days]).filter(Boolean));
    const byAction = {};
    for (const action of ACTIONS) {
      const group = signals.filter(item => item.action === action);
      if (group.length) byAction[action] = { count: group.length, d5: summarize(group.map(item => item.outcomes?.[5]).filter(Boolean)) };
    }
    const feedback = { useful: signals.filter(item => item.feedback === "useful").length, notUseful: signals.filter(item => item.feedback === "not_useful").length };
    return { total: signals.length, active: signals.filter(item => item.status === "active").length, byDays, byAction, feedback, minSample: MIN_SAMPLE, hitPct: HIT_PCT };
  }

  /** 单只股票的历史建议复盘（喂给 AI 参考）：样本少或命中率居中时只观察，不给加减信心的方向。 */
  function review(code) {
    const signals = read().signals.filter(item => item.code === String(code || ""));
    const d5 = summarize(signals.map(item => item.outcomes?.[5]).filter(Boolean));
    const recent = signals.slice(0, 5).map(item => ({
      date: cnDate(Date.parse(item.createdAt)), action: ACTION_LABEL[item.action], status: item.status,
      d5: item.outcomes?.[5]?.status === "done" ? { verdict: item.outcomes[5].verdict, returnPct: item.outcomes[5].returnPct } : null,
      feedback: item.feedback
    }));
    const adjustment = !d5.enough ? "observe" : d5.hitRatePct !== null && d5.hitRatePct >= 60 ? "upgrade" : d5.hitRatePct !== null && d5.hitRatePct <= 40 ? "downgrade" : "neutral";
    return { code: String(code || ""), sampleSize: signals.length, completed: d5.completed, hitRatePct: d5.hitRatePct, avgReturnPct: d5.avgReturnPct, adjustment, recent,
      note: d5.enough ? "仅供参考，不能当作加大仓位的依据" : `已评样本 ${d5.completed} 条，不足 ${MIN_SAMPLE} 条，只作观察` };
  }

  return { record, list, update, remove, evaluatePending, stats, review };
}

module.exports = { createDecisionSignals, normalizePlan, applyRiskReview, evaluateSignal, summarize, expiryOf, isSignalStore,
  ACTIONS, ACTION_LABEL, HORIZONS, HORIZON_LABEL, EVAL_DAYS, MIN_SAMPLE };
