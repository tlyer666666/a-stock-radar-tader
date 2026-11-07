"use strict";
// 复盘技能（1.6.44）：AI 自主调用技能再写市场复盘。
const test = require("node:test");
const assert = require("node:assert/strict");
const { createReviewSkills, SKILLS } = require("./review-skills.cjs");
const { createAiReview } = require("./ai-review.cjs");

const fuyao = {
  available: true,
  limitUp: { count: 48, maxBoards: 4, boardCounts: [{ level: 1, label: "首板", count: 40 }],
    reasons: [{ reason: "固态电池", count: 6, stocks: [{ code: "600001", name: "甲", boards: 2 }] }, { reason: "业绩增长", count: 4, stocks: [] }],
    leaders: [{ code: "600002", name: "乙", boards: 4, reason: "羊+智能体", sealMoney: 3e8 }] },
  limitBreak: { count: 20, top: [{ code: "600003", name: "丙", changePct: 3.2, openTimes: 2 }] },
  limitDown: { count: 17, top: [{ code: "600004", name: "丁", changePct: -10 }] },
  sealRate: 0.585,
  ladder: { days: [{ date: "2026-11-03", tiers: [{ label: "4板", stocks: [{ name: "乙", nextDay: "晋级" }] }] }] },
  hotLists: { day: { hot: [{ code: "600005", name: "戊", rank: 1, changePct: 5 }], skyrocket: [] } },
  dragonTiger: { date: "2026-11-03", count: 50, topNet: [{ code: "600006", name: "己", net: 2.5e8, changePct: 10, reason: "涨停", concepts: ["机器人"] }], desks: [] },
  anomalies: [{ code: "600007", name: "庚", tag: "涨停", content: "公司签订重大合同", keywords: ["合同"] }]
};
const board = { industries: [{ name: "电池", returns: { r1: 1.6 }, poolLimitUps: 7, netInflow: 1.85e9, leaderName: "尚水智能" }, { name: "白酒", returns: { r1: 1.5 }, poolLimitUps: 1, netInflow: 3.2e9 }],
  concepts: [{ name: "固态电池", changePct: 3.1, limitUps: 6, netInflow: 8e8, limitUpStocks: [{ name: "甲" }] }] };
const sources = (extra = {}) => ({ loadFuyao: async () => fuyao, loadSectorBoard: async () => board,
  analyzeSector: async name => ({ name, memberCount: 107, limitUps: 7, returns: { r1: 1.64 }, constituents: [{ code: "301513", name: "尚水智能", changePct: 20, isLimitUp: true }, { code: "600008", name: "辛", changePct: -1 }] }),
  loadProfiles: async list => ({ profiles: list.map(item => ({ code: item.code, name: "甲", latest: 10, ma: { ma60: 13 }, alignment: "均线交织", changePct: 2 })) }),
  previousReviews: () => [{ asOfDate: "2026-11-02", headline: "分歧", cycle: { phase: "分歧" }, mainlines: [{ name: "机器人" }], nextDay: { posture: "低吸" } }],
  situationOf: () => ["深跌底部"], ...extra });

test("every skill returns a short summary and compact data; a failing source is reported, not thrown", async () => {
  const skills = createReviewSkills(sources());
  assert.equal(skills.catalog.length, SKILLS.length);
  const sector = await skills.runSkill("sector_strength", { kind: "industry", sortBy: "netInflow", top: 5 });
  assert.equal(sector.ok, true);
  assert.equal(sector.data.top[0].name, "白酒");
  assert.equal(sector.data.top[0].netInflowYi, 32);
  assert.match((await skills.runSkill("limit_reasons")).summary, /涨停 48 家.*固态电池6/);
  assert.match((await skills.runSkill("broken_boards")).summary, /炸板 20 家，跌停 17 家，封板率 59%/);
  assert.equal((await skills.runSkill("ladder")).data.leaders[0].boards, 4);
  assert.equal((await skills.runSkill("dragon_tiger")).data.topNet[0].netYi, 2.5);
  assert.equal((await skills.runSkill("stock_check", { codes: ["600001", "bad"] })).data.stocks[0].ma60GapPct, -23.1);
  assert.match((await skills.runSkill("sector_members", { name: "电池" })).summary, /成分 107 只，上涨 1 只，涨停 7 只/);
  await skills.runSkill("sector_members", { name: "白酒" });
  assert.equal((await skills.runSkill("sector_members", { name: "保险" })).ok, false, "at most two sector lookups per review");
  assert.equal((await skills.runSkill("nope")).ok, false);
  const missing = createReviewSkills(sources({ loadFuyao: async () => ({ available: false }) }));
  const result = await missing.runSkill("limit_reasons");
  assert.equal(result.ok, false);
  assert.match(result.summary, /暂不可用/);
});

const snapshot = { date: "2026-11-03", market: { upCount: 1200, downCount: 3300 }, ecology: { limitUpCount: 48, failedBoards: 20, maxHeight: 4, themes: [{ reason: "羊", count: 10 }] },
  focusSectors: [{ name: "保险", score: 70 }], regime: { name: "退潮防守" } };
const final = { headline: "退潮期防守为主", cycle: { phase: "退潮", reason: "涨停48、跌停17" }, market: "赚钱效应差", mainlines: [{ name: "固态电池", comment: "6家涨停" }, { name: "编造的主线", comment: "x" }],
  ladder: "最高4板", indices: "破位", nextDay: { posture: "防守", focus: ["固态电池前排"], avoid: ["高位"] }, risks: ["跌停扩散"], confidence: "中" };

test("the AI decides which skills to call, round by round, then writes the review; mainline names may come from skill results", async () => {
  const seen = [];
  const replies = [
    { thought: "先看主线和梯队", calls: [{ skill: "limit_reasons", args: {} }, { skill: "sector_strength", args: { kind: "concept", sortBy: "limitUps" } }] },
    { thought: "核对风险", calls: [{ skill: "broken_boards", args: {} }] },
    { thought: "够了", final }
  ];
  const ai = { model: () => "m", chat: async ({ messages, system }) => { seen.push({ messages: messages.length, system }); return replies.shift(); } };
  const review = await createAiReview({ ai }).marketReview({ snapshot, skills: createReviewSkills(sources()) });
  assert.equal(review.mode, "skills");
  assert.deepEqual(review.steps.map(step => step.calls.map(call => call.skill)), [["limit_reasons", "sector_strength"], ["broken_boards"], []]);
  assert.match(review.steps[0].calls[0].summary, /涨停 48 家/);
  assert.deepEqual(review.mainlines.map(item => item.name), ["固态电池"], "a concept found by a skill is accepted, an invented one is dropped");
  assert.deepEqual(seen.map(item => item.messages), [1, 3, 5], "each round sends the earlier calls and their results");
  assert.match(seen[0].system, /sector_strength「板块强度」/);
});

test("when the AI keeps calling skills it is told to stop, and a missing conclusion falls back to a plain review with what was collected", async () => {
  let calls = 0;
  const ai = { model: () => "m", chat: async ({ user }) => {
    calls += 1;
    if (user) { assert.match(user, /skillResults/); return final; }
    return { thought: "再查", calls: [{ skill: "anomalies", args: { top: calls + 3 } }] };
  } };
  const review = await createAiReview({ ai }).marketReview({ snapshot, skills: createReviewSkills(sources()) });
  assert.equal(calls, 5, "three skill rounds, one last chance, then the plain fallback");
  assert.equal(review.headline, "退潮期防守为主");
  assert.equal(review.steps.length, 3);
});

test("without skills the review still works the old single-shot way", async () => {
  const ai = { model: () => "m", chat: async ({ user }) => { assert.ok(user); return final; } };
  const review = await createAiReview({ ai }).marketReview({ snapshot });
  assert.equal(review.mode, undefined);
  assert.deepEqual(review.mainlines.map(item => item.name), [], "without skill results only the page's sectors and themes count");
});
