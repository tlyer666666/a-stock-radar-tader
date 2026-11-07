"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const review = require("./ai-review.cjs");
const { createAiService } = require("./ai-service.cjs");

const config = { baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-test" };
const reply = content => ({ json: async () => ({ choices: [{ message: { content: JSON.stringify(content) } }] }) });
const snapshot = (date, extra = {}) => ({
  date, session: "收盘复盘", score: 58, regime: { name: "高位分歧", posture: "降低追高" }, dimensions: { trend: 60, emotion: 55 },
  market: { available: true, upCount: 3100, downCount: 1900, flatCount: 200, breadth: 0.6, averageReturn: 0.8 },
  ecology: { limitUpCount: 72, limitDownCount: 8, failedBoards: 25, failedRate: 0.26, promotionRate: 0.31, firstBoards: 55, continuationBoards: 17, maxHeight: 5, sealRate: 0.74, themes: [{ reason: "机器人", count: 9 }] },
  indices: [{ name: "上证指数", returns: { r1: 0.5, r5: 1.2 }, close: 3300, ma20: 3250, volumeRatio: 1.1 }],
  focusSectors: [{ name: "人形机器人", score: 82, verdict: "主线候选", relativeReturn: 2.1, poolShare: 0.12 }],
  leaders: [{ name: "甲股份", consecutiveBoards: 5, industry: "机械", thsReason: "机器人", openBoardCount: 0 }],
  riskSignals: ["炸板率超过32%"], fuyao: { available: false }, ...extra
});

test("the market snapshot is compacted to statistics and names only", () => {
  const input = review.compactMarketSnapshot(snapshot("2026-11-03", { leaders: [{ name: "甲", consecutiveBoards: 5, secretToken: "x" }] }));
  assert.equal(input.date, "2026-11-03");
  assert.equal(input.limits.limitUp, 72);
  assert.equal(input.limits.failedRatePct, 26);
  assert.equal(input.breadth.upRatioPct, 60);
  assert.deepEqual(input.sectors[0], { name: "人形机器人", score: 82, verdict: "主线候选", relativeReturn: 2.1, limitUpSharePct: 12 });
  assert.equal(JSON.stringify(input).includes("secretToken"), false);
  assert.equal(review.compactMarketSnapshot(null).date, "");
});

test("market review output is validated: cycle from a fixed list, mainlines only from input sectors or themes", () => {
  const input = review.compactMarketSnapshot(snapshot("2026-11-03"));
  const value = review.validateMarketReview({ headline: "分歧", cycle: { phase: "疯牛", reason: "涨停 72 家" }, market: "m",
    mainlines: [{ name: "人形机器人", comment: "前排强" }, { name: "机器人", comment: "题材" }, { name: "编造板块", comment: "x" }],
    nextDay: { posture: "低吸", focus: ["a", "b", "c", "d", "e", "f"], avoid: ["x"] }, risks: ["r"], confidence: "很高" }, input);
  assert.equal(value.cycle.phase, "混沌", "unknown cycle names fall back");
  assert.deepEqual(value.mainlines.map(item => item.name), ["人形机器人", "机器人"]);
  assert.equal(value.nextDay.focus.length, 5);
  assert.equal(value.confidence, "中");
  assert.equal(value.softwareRegime, "高位分歧");
  assert.throws(() => review.validateMarketReview({}, input), { code: "AI_BAD_OUTPUT" });
});

test("lookback verdicts use fixed results and compute a hit rate over the checkable ones", () => {
  const value = review.validateLookback({ summary: "s", verdicts: [{ claim: "a", result: "兑现" }, { claim: "b", result: "部分兑现" }, { claim: "c", result: "未兑现" }, { claim: "d", result: "随便" }], lessons: ["l"] });
  assert.equal(value.verdicts[3].result, "无法判断");
  assert.equal(value.judged, 3);
  assert.equal(value.hitRatePct, 50);
  assert.throws(() => review.validateLookback({ verdicts: [] }), { code: "AI_BAD_OUTPUT" });
});

test("page data for interpretations drops secrets, bounds depth and size", () => {
  const data = { apiKey: "sk-1", rows: Array.from({ length: 500 }, (_, i) => ({ name: `股票${i}`, value: i, nested: { a: { b: { c: { d: 1 } } } } })) };
  const text = review.boundedJson(data);
  assert.ok(text.length <= 18000);
  assert.equal(text.includes("sk-1"), false);
  assert.equal(text.includes("\"d\""), false, "objects deeper than four levels are dropped");
});

test("the service saves market reviews per day, looks back at the previous day and keeps interpretations apart", async () => {
  const prompts = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const system = body.messages[0].content;
    prompts.push(system);
    if (/事后核对/.test(system)) {
      const user = JSON.parse(body.messages[1].content);
      assert.equal(user.previous.date, "2026-11-02");
      return reply({ summary: "基本兑现", verdicts: [{ claim: "机器人延续", result: "兑现", evidence: "涨停 9 家" }], lessons: [] });
    }
    if (/涨停生态数据/.test(system)) return reply({ headline: "题材集中", points: ["机器人 9 家"], risks: [], watch: [] });
    return reply({ headline: "分歧", cycle: { phase: "分歧", reason: "炸板 25 家" }, market: "m", mainlines: [], nextDay: { posture: "低吸", focus: [], avoid: [] }, risks: [], confidence: "中" });
  };
  let stored = null;
  const service = createAiService({ getConfig: () => config, fetchImpl, store: { read: () => stored, write: value => { stored = value; } } });
  await assert.rejects(service.lookback({ snapshot: snapshot("2026-11-02") }), /还没有更早的 AI 市场复盘/);
  const first = await service.marketReview({ snapshot: snapshot("2026-11-02") });
  assert.equal(first.cached, false);
  assert.equal((await service.marketReview({ snapshot: snapshot("2026-11-02") })).cached, true);
  assert.equal(service.cachedMarketReview("2026-11-02").headline, "分歧");
  assert.equal(service.previousMarketReview("2026-11-03").asOfDate, "2026-11-02");
  const back = await service.lookback({ snapshot: snapshot("2026-11-03") });
  assert.equal(back.previousDate, "2026-11-02");
  assert.equal(back.hitRatePct, 100);
  assert.equal(service.cachedLookback("2026-11-03").summary, "基本兑现");
  const eco = await service.interpret({ kind: "ecology", data: { limitUp: { count: 72 } }, asOfDate: "2026-11-03" });
  assert.equal(eco.title, "涨停生态");
  assert.equal(service.cachedInterpret("ecology", "2026-11-03").headline, "题材集中");
  assert.equal(service.cachedInterpret("sectors", "2026-11-03"), null);
  await assert.rejects(service.interpret({ kind: "nope", data: {}, asOfDate: "2026-11-03" }), { code: "INVALID_IPC_PAYLOAD" });
  assert.deepEqual(service.history(), [], "reviews do not show up as AI stock-picking history days");
});
