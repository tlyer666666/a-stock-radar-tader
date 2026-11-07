"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fw = require("./ai-frameworks.cjs");

const strong = { latest: 20, changePct: 4, volumeRatio: 1.6, avgAmount20Yi: 5, return20: 18, bias5: 1.5, rsi14: 62, alignment: "多头排列",
  above: { ma5: true, ma10: true, ma20: true, ma60: true }, macd: { dif: 0.4, dea: 0.2, hist: 0.4, histTrend: "放大", cross: "金叉", crossDays: 1 },
  consecutiveBoards: 0, daysSinceLimit: 2, limitUps20: 2, broken20: 0, limitReason: "机器人", support: [{ label: "5日线", price: 19.7 }], resistance: [{ label: "近20日最高", price: 23 }], gaps: [] };
const hot = { ...strong, rsi14: 86, bias5: 9, return20: 60, broken20: 2 };

test("built-in frameworks weigh the right dimensions and score a healthy stock above an overheated one", () => {
  const technical = fw.resolveFramework({ active: "technical" });
  assert.deepEqual(Object.keys(technical.weights), ["trend", "macd", "rsi", "volume", "position", "levels", "news", "edge"]);
  const good = fw.evaluateFramework(technical, strong, { limitUpCount: 90, sealRatePct: 75 });
  const bad = fw.evaluateFramework(technical, hot, null);
  assert.ok(good.base >= 70, `healthy base ${good.base}`);
  assert.ok(bad.base < good.base);
  assert.equal(good.cap, null);
  assert.deepEqual(bad.caps, ["RSI14 超过 80 不给关注", "高于 5 日线 5% 以上不追高"]);
  assert.equal(good.dims.find(dim => dim.id === "macd").note, "零轴上金叉（1 天前）");
  const short = fw.evaluateFramework(fw.resolveFramework({ v: 2, active: "shortline" }), hot, null);
  assert.ok(short.caps.includes("近 20 日炸板 2 次以上且未连板不给关注"));
  assert.equal(short.dims.find(dim => dim.id === "theme").note.startsWith("题材：机器人"), true);
});

test("the AI may only move the base score by 15 points, and hard rules cap the result at 59", () => {
  const evaluation = { base: 70, cap: null };
  assert.equal(fw.settleScore(99, evaluation), 85);
  assert.equal(fw.settleScore(20, evaluation), 55);
  assert.equal(fw.settleScore("乱写", evaluation), 70);
  assert.equal(fw.settleScore(80, { base: 70, cap: 59 }), 59);
  assert.equal(fw.settleScore(130, { base: 95, cap: null }), 100);
});

test("custom frameworks are validated and change the cache signature", () => {
  assert.throws(() => fw.normalizeCustom({ weights: { trend: 0 } }), { code: "INVALID_AI_FRAMEWORK" });
  const custom = fw.normalizeCustom({ name: "  我的  回踩法 ", weights: { trend: 40, levels: 60, nope: 50, risk: 300 }, caps: ["downtrend", "bogus"], note: "x".repeat(600) });
  assert.equal(custom.name, "我的 回踩法");
  assert.deepEqual(custom.weights, { trend: 40, levels: 60, risk: 100 });
  assert.deepEqual(custom.caps, ["downtrend"]);
  assert.equal(custom.note.length, 500);
  const state = fw.normalizeFrameworkState({ active: "custom", custom });
  const resolved = fw.resolveFramework(state);
  assert.equal(resolved.name, "我的 回踩法");
  assert.notEqual(fw.frameworkSignature(resolved), fw.frameworkSignature(fw.resolveFramework({ active: "technical" })));
  assert.equal(fw.normalizeFrameworkState({ active: "nope" }).active, "auto", "unknown choices fall back to AI orchestration");
  const catalog = fw.frameworkCatalog(state);
  assert.equal(catalog.frameworks.length, 16, "AI 编排 + 14 套策略 + 自定义");
  assert.equal(catalog.dimensions.length, 15);
  assert.match(fw.frameworkPrompt(resolved), /上下 15 分以内/);
});

test("company announcements score the news dimension, and a severe risk notice caps the score", () => {
  const technical = fw.resolveFramework({ active: "technical" });
  const news = profile => fw.evaluateFramework(technical, profile, null).dims.find(dim => dim.id === "news");
  assert.equal(news({ ...strong, announcements: [] }).score, 55);
  assert.equal(news({ ...strong, announcements: [], announcementsAvailable: false }).note, "公告未取到，按中性");
  const good = news({ ...strong, announcements: [{ title: "中标", direction: "利好", risk: 0 }, { title: "回购", direction: "利好", risk: 0 }] });
  assert.equal(good.score, 71);
  const severe = { ...strong, announcements: [{ title: "收到立案告知书", direction: "利空", risk: 3 }] };
  assert.equal(news(severe).score, 3);
  const evaluation = fw.evaluateFramework(technical, severe, null);
  assert.deepEqual(evaluation.caps, ["近 30 天有重大风险公告不给关注"]);
  assert.equal(fw.settleScore(90, evaluation), 59);
});

test("the playbook library recognises each stock's situation and the AI picks and weights the playbooks it uses", () => {
  const boards = { ...strong, consecutiveBoards: 3, daysSinceLimit: 0, limitReason: "机器人" };
  const relay = fw.evaluateAuto(boards, { limitUpCount: 90, sealRatePct: 75 });
  assert.ok(relay.situation.includes("连板中") && relay.situation.includes("强市"));
  assert.equal(relay.candidates[0].id, "relay", "a board-chasing stock is matched to relay first");
  const deep = { ...strong, latest: 10, ma: { ma5: 10.2, ma10: 10.4, ma20: 11, ma60: 13 }, alignment: "均线交织", daysSinceLimit: 3, limitReason: "", return60: -30, high20: 11.5, low20: 9.5, high60: 15 };
  const bottom = fw.evaluateAuto(deep, null);
  assert.ok(bottom.situation.includes("深跌底部首板后"));
  assert.equal(bottom.candidates[0].id, "bottom_reversal");
  assert.ok(bottom.plays.length >= 1 && bottom.plays.reduce((sum, item) => sum + item.weight, 0) >= 99);
  const picked = fw.applyOrchestration(bottom, [{ id: "bottom_reversal", weight: 70 }, { id: "limit_pullback", weight: 30 }, { id: "bogus", weight: 50 }], "深跌首板后回踩");
  assert.deepEqual(picked.plays.map(item => [item.id, item.weight]), [["bottom_reversal", 70], ["limit_pullback", 30]]);
  const weighted = (bottom.candidates.find(item => item.id === "bottom_reversal").base * 70 + bottom.candidates.find(item => item.id === "limit_pullback").base * 30) / 100;
  const expected = Math.round(weighted * (100 - fw.AUTO_EDGE_WEIGHT) / 100 + bottom.edge.score * fw.AUTO_EDGE_WEIGHT / 100);
  assert.equal(picked.base, expected, "the base is the weighted base of the chosen playbooks blended with the measured-edge score");
  assert.equal(picked.dims.at(-1).id, "edge", "the measured-edge dimension is always shown in auto mode");
  assert.equal(picked.orchestration, "深跌首板后回踩");
  assert.match(picked.name, /底部反转 70% \+ 涨停后低吸 30%/);
  assert.equal(fw.applyOrchestration(bottom, [{ id: "nope" }]).base, bottom.base, "an invalid choice keeps the software default");
  const capped = fw.applyOrchestration(fw.evaluateAuto(hot, null), ["risk_check"]);
  assert.ok(capped.caps.length >= 2 && capped.cap === 59, "hard rules of the chosen playbook still cap the score");
  assert.match(fw.frameworkPrompt(fw.resolveFramework({ v: 2, active: "auto" })), /bottom_reversal「底部反转」/);
});

test("old saved choices migrate: the former default becomes AI orchestration, a deliberate choice is kept", () => {
  assert.equal(fw.normalizeFrameworkState({ active: "shortline" }).active, "auto");
  assert.equal(fw.normalizeFrameworkState({ active: "technical" }).active, "technical");
  assert.equal(fw.normalizeFrameworkState({ v: 2, active: "shortline" }).active, "shortline");
  assert.equal(fw.normalizeFrameworkState(null).active, "auto");
  for (const id of fw.PLAYBOOK_IDS) assert.ok(fw.resolveFramework({ v: 2, active: id }).weights, id);
});

test("the measured-edge dimension follows the full-market backtest: chasing limit-ups scores low, deep pullbacks score high", () => {
  const base = { latest: 20, changePct: 1, return20: 5, bias5: 0.5, rsi14: 52, consecutiveBoards: 0, limitUps20: 0, broken20: 0, ma: { ma60: 20 } };
  const neutral = fw.DIMENSIONS.edge.score(base);
  assert.equal(neutral.score, 60);
  const chase = fw.DIMENSIONS.edge.score({ ...base, changePct: 10, consecutiveBoards: 3, limitUps20: 3, return20: 35, bias5: 10, rsi14: 80 });
  assert.ok(chase.score <= 10, `chasing a 3-board stock scores ${chase.score}`);
  assert.match(chase.note, /^扣：.*3连板次日追入/);
  const deep = fw.DIMENSIONS.edge.score({ ...base, latest: 10, ma: { ma60: 13 }, bias5: -4, return20: -12, rsi14: 38 });
  assert.ok(deep.score >= 85, `deep pullback scores ${deep.score}`);
  assert.match(deep.note, /^加：离60日线 -23%/);
  // 实测里空头排列的股票 5 日相对收益并不差，空头排列不再作为策略的硬规则。
  for (const id of fw.PLAYBOOK_IDS) {
    assert.equal(fw.PLAYBOOKS[id].caps.includes("downtrend"), false, id);
    assert.equal(fw.PLAYBOOKS[id].weights.edge, 25, id);
  }
  const hot = fw.evaluateAuto({ ...base, changePct: 10, consecutiveBoards: 2, daysSinceLimit: 0, limitUps20: 2, alignment: "多头排列" }, { limitUpCount: 90, sealRatePct: 75 });
  const calm = fw.evaluateAuto({ ...base, latest: 10, ma: { ma60: 13 }, daysSinceLimit: 3, limitUps20: 1, return60: -30 }, null);
  assert.ok(calm.edge.score > hot.edge.score && calm.base > hot.base, `calm ${calm.base} vs hot ${hot.base}`);
  assert.match(fw.frameworkPrompt(fw.resolveFramework({ v: 2, active: "auto" })), /实测胜率/);
  assert.match(fw.frameworkPrompt(fw.resolveFramework({ v: 2, active: "relay" })), /实测胜率/);
});
