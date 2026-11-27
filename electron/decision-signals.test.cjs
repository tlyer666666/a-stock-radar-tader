"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createDecisionSignals, normalizePlan, evaluateSignal, summarize, MIN_SAMPLE } = require("./decision-signals.cjs");

const cn = text => Date.parse(`${text}+08:00`);
function hub(start = cn("2026-11-20T10:00:00"), bars = {}) {
  let state = null;
  let clock = start;
  let seq = 0;
  const api = createDecisionSignals({
    store: { read: () => state, write: value => { state = structuredClone(value); } },
    loadBars: async ({ code }) => { if (!bars[code]) throw new Error("no bars"); return bars[code]; },
    now: () => clock, id: () => `sig_${++seq}`
  });
  return { api, set: value => { clock = value; }, state: () => state };
}
const plan = extra => normalizePlan({ action: "buy", horizon: "5d", entryLow: 10, entryHigh: 10.2, stopLoss: 9.6, targetPrice: 11.5, invalidation: "跌破 9.6", watch: ["放量站上 10.5"], reason: "回踩 20 日线企稳", ...extra }, { referencePrice: 10.1 });
const bar = (date, close, low = close, high = close) => ({ date, close, low, high });

test("plans are validated: a buy without a stop or with contradictory prices is recorded as watch, with the reason", () => {
  const ok = plan();
  assert.equal(ok.plan.action, "buy");
  assert.equal(ok.guardrail, "");
  const noStop = plan({ stopLoss: null, invalidation: "" });
  assert.equal(noStop.plan.action, "watch");
  assert.equal(noStop.rawAction, "buy");
  assert.match(noStop.guardrail, /没有给出止损价或失效条件/);
  assert.match(plan({ stopLoss: 10.4 }).guardrail, /止损价不低于入场价/);
  assert.match(plan({ targetPrice: 10 }).guardrail, /目标价不高于入场价/);
  assert.match(plan({ stopLoss: 5 }).guardrail, /超过 30%/);
  const swapped = plan({ entryLow: 10.3, entryHigh: 10 });
  assert.deepEqual([swapped.plan.entryLow, swapped.plan.entryHigh], [10, 10.3]);
  assert.equal(normalizePlan({ action: "moon" }), null);
  assert.equal(normalizePlan(null), null);
  assert.equal(normalizePlan({ action: "sell", stopLoss: "abc", entryLow: -1 }).plan.stopLoss, null, "bad numbers stay null");
  assert.equal(normalizePlan({ action: "hold", horizon: "forever" }).plan.horizon, "5d");
});

test("a signal is recorded once per day, an opposite view invalidates it, and old ones expire", () => {
  const { api, set } = hub();
  const first = api.record({ code: "600519", name: "贵州茅台", ...plan(), stance: "偏多", confidence: "中", referencePrice: 10.1, source: { conversationId: "c1", model: "m" } });
  assert.equal(first.created, true);
  assert.equal(first.signal.status, "active");
  assert.equal(first.signal.referencePrice, 10.1);
  const again = api.record({ code: "600519", name: "贵州茅台", ...plan({ targetPrice: 12 }), referencePrice: 10.3 });
  assert.equal(again.created, false);
  assert.equal(again.signal.targetPrice, 12);
  assert.equal(again.signal.referencePrice, 10.1, "the price at first advice is kept");
  assert.equal(api.list().length, 1);
  set(cn("2026-11-23T10:00:00"));
  const sell = api.record({ code: "600519", name: "贵州茅台", ...normalizePlan({ action: "sell", horizon: "3d", reason: "跌破支撑" }), referencePrice: 9.5 });
  assert.equal(sell.created, true);
  const [latest, old] = api.list();
  assert.equal(latest.action, "sell");
  assert.equal(old.status, "invalidated");
  assert.match(old.endedReason, /方向相反的新建议：卖出/);
  set(cn("2026-12-20T10:00:00"));
  assert.equal(api.list({ status: "active" }).length, 0);
  assert.equal(api.list()[0].status, "expired");
  assert.equal(api.record({ code: "bad", ...plan() }), null);
});

test("outcomes: bullish advice is right at +1%, wrong at -1% or when the stop breaks; bearish is mirrored; watch is not judged", () => {
  const signal = { createdAt: new Date(cn("2026-11-20T10:00:00")).toISOString(), action: "buy", stopLoss: 9.6, targetPrice: 11.5, referencePrice: 10, outcomes: {} };
  const bars = [bar("2026-11-19", 9.9), bar("2026-11-20", 10.05), bar("2026-11-23", 10.3, 10.0, 10.4), bar("2026-11-24", 10.1), bar("2026-11-25", 10.6, 10.2, 10.7)];
  const out = evaluateSignal(signal, bars);
  assert.equal(out[1].verdict, "hit");
  assert.equal(out[1].returnPct, 3);
  assert.equal(out[3].verdict, "hit");
  assert.equal(out[3].maxAdversePct, 0);
  assert.equal(out[5], undefined, "not enough forward bars yet → evaluated later");
  const broken = evaluateSignal(signal, [bar("2026-11-23", 10.4, 9.5, 10.5)]);
  assert.equal(broken[1].verdict, "miss");
  assert.equal(broken[1].stopHit, true);
  assert.equal(broken[1].maxAdversePct, 5);
  const flat = evaluateSignal(signal, [bar("2026-11-23", 10.05, 9.9, 10.1)]);
  assert.equal(flat[1].verdict, "neutral");
  const bearish = evaluateSignal({ ...signal, action: "sell", stopLoss: null, targetPrice: null }, [bar("2026-11-23", 9.6, 9.5, 10.2)]);
  assert.equal(bearish[1].verdict, "hit");
  assert.equal(bearish[1].maxAdversePct, 2);
  assert.equal(evaluateSignal({ ...signal, action: "watch" }, bars)[1].status, "unable");
  assert.equal(evaluateSignal({ ...signal, referencePrice: null }, [bar("2026-11-23", 10.3)])[1].status, "unable", "no price at advice time and no earlier bar");
  assert.deepEqual(evaluateSignal({ ...signal, outcomes: { 1: { status: "done" } } }, [bar("2026-11-23", 10.3)]), {}, "already judged days are not redone");
});

test("statistics hide hit rates until there are enough judged samples", () => {
  const done = verdict => ({ status: "done", verdict, returnPct: verdict === "hit" ? 2 : -2, maxAdversePct: 1 });
  const few = summarize([done("hit"), done("miss"), { status: "unable", reason: "x" }]);
  assert.equal(few.completed, 2);
  assert.equal(few.enough, false);
  assert.equal(few.hitRatePct, null);
  assert.equal(few.avgReturnPct, null);
  const many = summarize([...Array(MIN_SAMPLE - 3).fill(done("hit")), ...Array(3).fill(done("miss"))]);
  assert.equal(many.enough, true);
  assert.equal(many.hitRatePct, 70);
  assert.equal(many.maxAdversePct, 1);
});

test("pending evaluation reads bars once per stock, survives a failing stock, and feeds review, feedback and stats", async () => {
  const bars = { "600519": [bar("2026-11-20", 10), bar("2026-11-23", 10.5, 10.1, 10.6)] };
  const { api, set } = hub(cn("2026-11-20T10:00:00"), bars);
  const a = api.record({ code: "600519", name: "贵州茅台", ...plan(), referencePrice: 10 }).signal;
  api.record({ code: "000001", name: "平安银行", ...plan(), referencePrice: 12 });
  set(cn("2026-11-23T16:00:00"));
  const result = await api.evaluatePending();
  assert.deepEqual(result, { evaluated: 1, failed: 1 });
  assert.equal(api.list({ code: "600519" })[0].outcomes[1].verdict, "hit");
  assert.equal(api.update(a.id, { feedback: "useful" }).feedback, "useful");
  assert.equal(api.update(a.id, { status: "closed" }).status, "closed");
  assert.throws(() => api.update(a.id, { status: "active" }), /只能把建议关闭或标记为失效/);
  assert.throws(() => api.update("nope", { feedback: "useful" }), /已不存在/);
  const stats = api.stats();
  assert.equal(stats.total, 2);
  assert.equal(stats.byDays[1].completed, 1);
  assert.equal(stats.byDays[1].hitRatePct, null, "one sample is not a hit rate");
  assert.equal(stats.feedback.useful, 1);
  const review = api.review("600519");
  assert.equal(review.sampleSize, 1);
  assert.equal(review.adjustment, "observe");
  assert.match(review.note, /不足 10 条/);
  assert.equal(api.remove(a.id).removed, 1);
  assert.equal(api.list().length, 1);
});

test("a risk-review veto turns a buy into watch and records why; other verdicts and actions are untouched", () => {
  const { applyRiskReview } = require("./decision-signals.cjs");
  const vetoed = applyRiskReview(plan(), { verdict: "veto", reasons: ["大盘退潮", "高位放量滞涨"] });
  assert.equal(vetoed.plan.action, "watch");
  assert.equal(vetoed.rawAction, "buy");
  assert.equal(vetoed.guardrail, "风险复核否决：大盘退潮；高位放量滞涨");
  assert.equal(applyRiskReview(plan(), { verdict: "downgrade", reasons: ["x"] }).plan.action, "buy");
  assert.equal(applyRiskReview(plan(), null).plan.action, "buy");
  const sell = normalizePlan({ action: "sell", horizon: "3d" });
  assert.equal(applyRiskReview(sell, { verdict: "veto" }).plan.action, "sell");
  assert.equal(applyRiskReview(null, { verdict: "veto" }), null);
});

test("grading ignores today's unfinished bar, keeps changes made while bars were loading, and tolerates malformed stored records", async () => {
  let state = { version: 1, signals: [{ id: "old", code: "600000", action: "hold", createdAt: "2026-11-10T02:00:00.000Z", updatedAt: "", expiresAt: "2026-12-30T00:00:00.000Z", status: "active", horizon: "5d" }, { junk: true }] };
  let clock = cn("2026-11-20T10:00:00");
  let release;
  let seq = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const api = createDecisionSignals({
    store: { read: () => structuredClone(state), write: value => { state = structuredClone(value); } }, now: () => clock, id: () => `sig_new${++seq}`,
    loadBars: async ({ code }) => { if (code === "600519") await gate; return [bar("2026-11-19", 10), bar("2026-11-20", 10.8, 9.2, 10.9), bar("2026-11-23", 10.5, 10.1, 10.6)]; }
  });
  assert.equal(api.list().length, 1, "a record without code/action is dropped on read");
  assert.deepEqual(api.list()[0].watch, [], "missing array fields are filled in");
  const made = api.record({ code: "600519", name: "贵州茅台", ...plan(), referencePrice: 10 }).signal;
  clock = cn("2026-11-21T10:00:00");
  // 11-21 盘中：11-20 是已收盘的建议日，之后没有已收盘的 K 线 → 不评。
  const early = createDecisionSignals({ store: { read: () => structuredClone(state), write: value => { state = structuredClone(value); } }, now: () => cn("2026-11-20T14:00:00"),
    loadBars: async () => [bar("2026-11-19", 10), bar("2026-11-20", 9.0, 8.8, 10.2)] });
  await early.evaluatePending();
  assert.equal(api.list({ code: "600519" })[0].outcomes[1], undefined, "an intraday bar never produces a permanent verdict");
  clock = cn("2026-11-23T16:00:00");
  const running = api.evaluatePending();
  api.update(made.id, { feedback: "not_useful" });            // 读日线期间用户点了反馈
  api.record({ code: "000001", name: "平安银行", ...plan(), referencePrice: 12 }); // 读日线期间又来了一条新建议
  release();
  await running;
  const after = api.list();
  assert.equal(after.find(item => item.id === made.id).feedback, "not_useful", "feedback given during evaluation survives");
  assert.ok(after.some(item => item.code === "000001"), "a suggestion recorded during evaluation survives");
  assert.equal(after.find(item => item.id === made.id).outcomes[1].verdict, "hit");
  assert.equal(api.record({ code: "510300", name: "沪深300ETF", ...plan(), referencePrice: 4 }).signal.assetType, "etf", "ETF codes are stored as ETFs even when the caller says stock");
});

test("H7, M3 & L2: invalid createdAt/expiresAt do not throw, stopLoss>=entryLow and null-ref 30% distance caught, active signals capped at 600, rawAction cleared on overwrite, evaluatePending is single-flight", async () => {
  // H7: invalid createdAt is dropped by tidy(), invalid expiresAt is repaired, evaluateSignal handles invalid createdAt safely
  let state = {
    version: 1,
    signals: [
      { id: "bad_ts", code: "600519", action: "buy", createdAt: "not-a-date", status: "active", horizon: "5d" },
      { id: "bad_exp", code: "600036", action: "hold", createdAt: "2026-11-10T02:00:00.000Z", expiresAt: "invalid", status: "active", horizon: "5d" }
    ]
  };
  let seq = 0;
  let loadCount = 0;
  let releaseBars;
  const gate = new Promise(resolve => { releaseBars = resolve; });
  const api = createDecisionSignals({
    store: { read: () => structuredClone(state), write: value => { state = structuredClone(value); } },
    loadBars: async () => { loadCount += 1; await gate; return [bar("2026-11-10", 10), bar("2026-11-11", 10.5)]; },
    now: () => cn("2026-11-20T10:00:00"),
    id: () => `s_${++seq}`
  });
  assert.equal(api.list().length, 1, "record with invalid createdAt is dropped instead of throwing RangeError");
  assert.equal(api.list()[0].id, "bad_exp");
  assert.equal(api.list()[0].status, "expired", "repaired expiresAt allows normal expiration");
  assert.deepEqual(evaluateSignal({ createdAt: "broken", action: "buy", referencePrice: 10 }, [bar("2026-11-20", 10.5)]), {});

  // M3: guardrail catches entryLow <= stopLoss < entryHigh and 30% distance when referencePrice is null
  const midStop = normalizePlan({ action: "buy", entryLow: 10, entryHigh: 11, stopLoss: 10.5, targetPrice: 13 }, { referencePrice: 10.6 });
  assert.equal(midStop.plan.action, "watch");
  assert.match(midStop.guardrail, /止损价不低于入场价/);
  const noRefFarStop = normalizePlan({ action: "buy", entryLow: 10, entryHigh: 10.2, stopLoss: 6, targetPrice: 12 }, { referencePrice: null });
  assert.equal(noRefFarStop.plan.action, "watch");
  assert.match(noRefFarStop.guardrail, /超过 30%/);

  // L2: same-day overwrite with empty rawAction removes stale rawAction
  const downgraded = api.record({ code: "600519", name: "贵州茅台", ...plan({ stopLoss: null, invalidation: "" }), referencePrice: 10 });
  assert.equal(downgraded.signal.action, "watch");
  assert.equal(downgraded.signal.rawAction, "buy");
  const cleanWatch = api.record({ code: "600519", name: "贵州茅台", ...normalizePlan({ action: "watch", horizon: "5d", reason: "主动观望" }), referencePrice: 10 });
  assert.equal(cleanWatch.created, false);
  assert.equal(cleanWatch.signal.rawAction, undefined, "stale rawAction is cleared when overwritten cleanly");

  // M3: evaluatePending single-flight lock deduplicates concurrent runs
  api.record({ code: "000001", name: "平安银行", ...plan(), referencePrice: 10 });
  const p1 = api.evaluatePending();
  const p2 = api.evaluatePending();
  releaseBars();
  const [r1, r2] = await Promise.all([p1, p2]);
  assert.deepEqual(r1, r2);
  assert.equal(loadCount, 3, "concurrent evaluatePending calls share a single run (3 unique codes loaded once each, not 6)");

  // M3: > 600 active signals are strictly capped at MAX_SIGNALS (600)
  const overflow = Array.from({ length: 615 }, (_, i) => ({
    id: `act_${i}`, code: String(600000 + (i % 500)), action: "hold", status: "active", horizon: "swing",
    createdAt: new Date(cn("2026-11-19T10:00:00") + i * 1000).toISOString(),
    expiresAt: new Date(cn("2026-12-30T10:00:00")).toISOString()
  }));
  state = { version: 1, signals: overflow };
  api.record({ code: "600999", name: "测试", ...plan(), referencePrice: 10 });
  assert.equal(state.signals.length, 600, "active signals are strictly capped at MAX_SIGNALS");
});
