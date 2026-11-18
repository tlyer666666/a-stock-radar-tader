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

test("recentMarketReviews attaches lookback hit rate & lessons, and subsequent marketReview receives previousLookback", async () => {
  const seenPayloads = [];
  let stored = null;
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    const system = body.messages[0].content;
    const user = JSON.parse(body.messages[1].content);
    seenPayloads.push({ system, user });
    if (/事后核对/.test(system)) {
      return reply({ summary: "次日高开低走需注意节奏", verdicts: [{ claim: "主线延续", result: "部分兑现", evidence: "分化明显" }], lessons: ["少追连板高标"] });
    }
    return reply({ headline: "分歧转弱", cycle: { phase: "分歧", reason: "炸板增加" }, market: "m", mainlines: [], nextDay: { posture: "防守", focus: [], avoid: [] }, risks: [], confidence: "中" });
  };
  const service = createAiService({ getConfig: () => config, fetchImpl, store: { read: () => stored, write: value => { stored = value; } } });
  await service.marketReview({ snapshot: snapshot("2026-11-02") });
  await service.lookback({ snapshot: snapshot("2026-11-03") });
  const recent = service.recentMarketReviews("2026-11-04", 3);
  assert.equal(recent[0].lookbackHitRatePct, 50);
  assert.deepEqual(recent[0].lookbackLessons, ["少追连板高标"]);
  await service.marketReview({ snapshot: snapshot("2026-11-04") });
  const lastUser = seenPayloads.at(-1).user;
  assert.equal(lastUser.previousLookback.hitRatePct, 50);
  assert.deepEqual(lastUser.previousLookback.lessons, ["少追连板高标"]);
});

test("Phase 2: skillReview & interpret stream intermediate steps and token previews via onProgress", async () => {
  const events = [];
  let turn = 0;
  const fakeAi = {
    model: () => "stream-model",
    chat: async ({ onToken }) => {
      turn += 1;
      onToken?.('{"headline":"', '{"headline":"盘后主线聚焦算力"}', {});
      if (turn === 1) {
        return { thought: "先核对板块强度", calls: [{ skill: "sector_board", args: {} }] };
      }
      if (turn === 2) {
        return {
          thought: "数据充足，输出复盘",
          final: {
            headline: "盘后主线聚焦算力",
            market: "成交放量",
            cycle: { phase: "主升", reason: "高度拓展" },
            mainlines: [{ name: "算力", comment: "资金回流" }],
            ladder: "5板领涨",
            indices: "沪强深弱",
            nextDay: { posture: "围绕核心低吸", focus: ["算力"], avoid: ["杂毛"] },
            risks: ["防冲高回落"],
            confidence: "高"
          }
        };
      }
      return { headline: "解读标题", points: ["主线活跃"], risks: ["高位分化"], watch: ["明早竞价"] };
    }
  };
  const reviewer = review.createAiReview({ ai: fakeAi });
  const market = await reviewer.marketReview({
    snapshot: snapshot("2026-11-05"),
    onProgress: evt => events.push(evt),
    skills: {
      runSkill: async skill => ({ skill, name: "板块强度", ok: true, summary: "算力领涨", data: { topSector: "算力" } })
    }
  });
  assert.equal(market.headline, "盘后主线聚焦算力");
  assert.ok(events.some(e => e.channel === "market-review" && e.phase === "step" && e.pendingStep));
  assert.ok(events.some(e => e.channel === "market-review" && e.phase === "step" && e.steps.length >= 1));
  assert.ok(events.some(e => e.channel === "market-review" && e.phase === "token" && e.text.includes("算力")));

  const interp = await reviewer.interpret({
    kind: "sectors",
    data: { rows: ["算力"] },
    asOfDate: "2026-11-05",
    onProgress: evt => events.push(evt)
  });
  assert.equal(interp.headline, "解读标题");
  assert.ok(events.some(e => e.channel === "interpret" && e.kind === "sectors" && e.phase === "token"));
});

test("cachedMarketReview aligns cache key cleanly across active config and summary instructions", async () => {
  let stored = null;
  let activeModel = "model-a";
  let summaryInstr = "严格控制回撤";
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    return reply({
      headline: `复盘-${body.model}`,
      cycle: { phase: "分歧", reason: "测试" },
      market: "m",
      mainlines: [],
      nextDay: { posture: "低吸", focus: [], avoid: [] },
      risks: [],
      confidence: "中"
    });
  };
  const service = createAiService({
    getConfig: () => ({ ...config, model: activeModel }),
    getInstructions: () => ({ summary: summaryInstr }),
    fetchImpl,
    store: { read: () => stored, write: value => { stored = value; } }
  });
  await service.marketReview({ snapshot: snapshot("2026-11-06") });
  assert.equal(service.cachedMarketReview("2026-11-06")?.headline, "复盘-model-a");
  summaryInstr = "换了自定义总结规则";
  assert.equal(service.cachedMarketReview("2026-11-06"), null);
});
