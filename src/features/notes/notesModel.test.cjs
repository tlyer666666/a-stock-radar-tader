"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let model;
let restoreTypeScript;
before(() => { restoreTypeScript = registerTypeScript(); model = require("./notesModel.ts"); });
after(() => restoreTypeScript?.());

/** 北京时间 → 毫秒。 */
const cn = text => Date.parse(`${text}+08:00`);
const iso = text => new Date(cn(text)).toISOString();
// 2026-11-12 是周四、交易日；11-14/15 周末。
const NOW = cn("2026-11-12T15:12:00");

test("识别常用说法：明天开盘前、下个交易日竞价、周五尾盘、具体钟点、几分钟后", () => {
  const at = text => { const r = model.parseRemind(text, NOW); return r && new Date(r.at).toISOString(); };
  assert.equal(at("明天开盘前看下茅台"), iso("2026-11-13T09:15:00"));
  assert.equal(at("下个交易日竞价看600519有没有高开"), iso("2026-11-13T09:15:00"));
  assert.equal(at("周五尾盘考虑减仓"), iso("2026-11-13T14:45:00"));
  assert.equal(at("下周一 10:30 复核"), iso("2026-11-16T10:30:00"));
  assert.equal(at("明天下午两点半卖掉一半"), iso("2026-11-13T14:30:00"));
  assert.equal(at("3点前处理"), iso("2026-11-13T15:00:00"), "今天 15 点已过，顺延到明天");
  assert.equal(at("30分钟后看分时"), new Date(NOW + 30 * 60_000).toISOString());
  assert.equal(at("半小时后看看"), new Date(NOW + 30 * 60_000).toISOString());
  assert.equal(at("11月20日 看财报"), iso("2026-11-20T09:15:00"));
  assert.equal(at("今晚八点复盘"), iso("2026-11-12T20:00:00"));
  assert.equal(model.parseRemind("这只票的逻辑是供给收缩", NOW), null, "没有时间说法就不提醒");
  assert.equal(model.parseRemind("跌破5日线就减仓，20日均线是支撑", NOW), null, "5日线不是 5 号");
  assert.equal(model.parseRemind("10日内涨幅超过30%要小心", NOW), null);
  assert.equal(model.parseRemind("大盘跌了20点，3200点位有支撑", NOW), null, "点数不是钟点");
  assert.equal(at("明天跌破5日线就卖"), iso("2026-11-13T09:15:00"), "有日期时照常识别");
  assert.equal(at("15号看一下"), iso("2026-11-15T09:15:00"));
});

test("交易日规则：周末和节假日跳过；周五说「明天开盘」落到下周一", () => {
  const friday = cn("2026-11-13T16:00:00");
  assert.equal(new Date(model.parseRemind("明天开盘看看", friday).at).toISOString(), iso("2026-11-16T09:30:00"));
  assert.equal(model.isTradingDay("2026-11-14"), false);
  assert.equal(model.isTradingDay("2026-10-01"), false, "国庆休市");
  assert.equal(model.nextTradingDay("2026-09-30"), "2026-10-08");
});

test("重复提醒：每个交易日尾盘，发出后排到下一个交易日", () => {
  const parsed = model.parseRemind("每个交易日尾盘检查仓位", NOW);
  assert.equal(parsed.repeat, "tradingDays");
  assert.equal(new Date(parsed.at).toISOString(), iso("2026-11-13T14:45:00"));
  const note = model.normalizeNote({ id: "a", text: "检查仓位", createdAt: iso("2026-11-12T15:00:00"), remindAt: iso("2026-11-13T14:45:00"), repeat: "tradingDays" });
  const fired = model.markFired(note, cn("2026-11-13T14:45:10"));
  assert.equal(fired.remindAt, iso("2026-11-16T14:45:00"));
  assert.equal(fired.firedFor, null);
  assert.equal(fired.lastFiredAt, iso("2026-11-13T14:45:00"));
  const normalized = model.normalizeNote(fired);
  assert.equal(normalized.lastFiredAt, iso("2026-11-13T14:45:00"));
});

test("到期：不重复的提醒发一次后停在「待处理」，不会反复响；稍后提醒重新排期", () => {
  const note = model.normalizeNote({ id: "b", text: "看 600519", createdAt: iso("2026-11-12T10:00:00"), remindAt: iso("2026-11-12T15:00:00") });
  assert.deepEqual(model.dueToFire([note], NOW).map(n => n.id), ["b"]);
  const fired = model.markFired(note, NOW);
  assert.deepEqual(model.dueToFire([fired], NOW), []);
  assert.deepEqual(model.awaiting([fired]).map(n => n.id), ["b"]);
  const later = model.snooze(fired, NOW + 600_000);
  assert.deepEqual(model.awaiting([later]), []);
  assert.deepEqual(model.dueToFire([later], NOW + 600_000).map(n => n.id), ["b"]);
  assert.deepEqual(model.dueToFire([{ ...fired, done: true, firedFor: null }], NOW), [], "已完成的不提醒");
});

test("存储归一：空文字丢弃、坏时间清掉、股票代码校验、排序把待处理放最前", () => {
  const store = model.normalizeNotes({ notes: [
    { id: "1", text: "  " },
    { id: "2", text: "没提醒", createdAt: iso("2026-11-12T09:00:00"), updatedAt: iso("2026-11-12T09:00:00"), remindAt: "bad", repeat: "daily" },
    { id: "3", text: "待处理", createdAt: iso("2026-11-12T09:00:00"), remindAt: iso("2026-11-12T10:00:00"), firedFor: iso("2026-11-12T10:00:00"), stock: { code: "600519", name: "贵州茅台" } },
    { id: "4", text: "明天", createdAt: iso("2026-11-12T09:00:00"), remindAt: iso("2026-11-13T09:15:00"), stock: { code: "bad" } }
  ], voice: false });
  assert.deepEqual(store.notes.map(n => n.id), ["2", "3", "4"]);
  assert.equal(store.notes[0].repeat, "none", "没有提醒时间就没有重复");
  assert.equal(store.notes[1].stock.secid, "1.600519");
  assert.equal(store.notes[2].stock, null);
  assert.equal(store.voice, false);
  assert.deepEqual(model.sortNotes(store.notes).map(n => n.id), ["3", "4", "2"]);
  assert.equal(model.detectStockCode("关注 002594 和 600519"), "002594");
  assert.equal(model.detectStockCode("电话 13800001111"), null);
});

test("显示：今天/明天/周几/日期", () => {
  assert.equal(model.formatRemind(iso("2026-11-12T20:00:00"), NOW), "今天 20:00");
  assert.equal(model.formatRemind(iso("2026-11-13T09:15:00"), NOW), "明天 09:15");
  assert.equal(model.formatRemind(iso("2026-11-16T10:30:00"), NOW), "11月16日（周一） 10:30");
  assert.ok(model.presetTimes(NOW).every(item => item.at > NOW));
});

test("价格条件：具体价位和涨跌幅才识别，均线、均价线、股票代码不算", () => {
  assert.deepEqual(model.parseCondition("002594 跌破 280 提醒我减仓"), { field: "latest", op: "lte", value: 280 });
  assert.deepEqual(model.parseCondition("600519 涨到1500.5元就卖一半"), { field: "latest", op: "gte", value: 1500.5 });
  assert.deepEqual(model.parseCondition("突破12.3加仓"), { field: "latest", op: "gte", value: 12.3 });
  assert.deepEqual(model.parseCondition("跌到10元以下止损"), { field: "latest", op: "lte", value: 10 });
  assert.deepEqual(model.parseCondition("涨幅超过5%先走"), { field: "changePct", op: "gte", value: 5 });
  assert.deepEqual(model.parseCondition("跌超 3% 就止损"), { field: "changePct", op: "lte", value: -3 });
  assert.equal(model.parseCondition("跌破5日线就卖"), null);
  assert.equal(model.parseCondition("跌破均价线减仓"), null);
  assert.equal(model.parseCondition("突破前高再说"), null);
  assert.equal(model.parseCondition("突破600519"), null, "6 位数是代码");
  assert.equal(model.parseCondition("今天看一下"), null);
  assert.equal(model.describeCondition({ field: "changePct", op: "lte", value: -3 }), "跌幅 ≥ 3%");
  // 先出现的条件为准
  assert.deepEqual(model.parseCondition("跌破 10 止损，涨到 12 止盈"), { field: "latest", op: "lte", value: 10 });
});

test("价格条件存储：没股票不存条件；触发后算待处理；重新盯清掉触发记录", () => {
  const store = model.normalizeNotes({ notes: [
    { id: "a", text: "跌破280", createdAt: iso("2026-11-12T09:00:00"), stock: { code: "002594", name: "比亚迪" }, condition: { field: "latest", op: "lte", value: 280 } },
    { id: "b", text: "没股票", createdAt: iso("2026-11-12T09:00:00"), condition: { field: "latest", op: "lte", value: 280 } },
    { id: "c", text: "坏条件", createdAt: iso("2026-11-12T09:00:00"), stock: { code: "600519" }, condition: { field: "latest", op: "lte", value: -1 } },
    { id: "d", text: "已触发", createdAt: iso("2026-11-12T09:00:00"), stock: { code: "600519" }, condition: { field: "changePct", op: "gte", value: 5 },
      conditionHit: { at: iso("2026-11-12T10:00:00"), detail: "贵州茅台 涨跌幅 +5.2%" },
      ai: { conversationId: "c1", runId: null, status: "done", answer: "**先别追**", stance: "中性", at: iso("2026-11-12T10:01:00"), trigger: "auto" } }
  ], aiAuto: true });
  assert.ok(store.notes[0].condition);
  assert.equal(store.notes[1].condition, null);
  assert.equal(store.notes[2].condition, null);
  assert.equal(store.aiAuto, true);
  assert.deepEqual(model.watchingConditions(store.notes).map(n => n.id), ["a"]);
  assert.deepEqual(model.awaiting(store.notes).map(n => n.id), ["d"]);
  assert.equal(store.notes[3].ai.trigger, "auto");
  assert.equal(model.sortNotes(store.notes)[0].id, "d", "触发的排最前");
  assert.equal(model.normalizeNotes({ notes: [] }).aiAuto, false, "默认不自动问 AI");
});

test("让 AI 看看：问题里带原文、股票、条件状态和当前时间", () => {
  const [note] = model.normalizeNotes({ notes: [{ id: "d", text: "涨超5%就卖一半", createdAt: iso("2026-11-12T09:00:00"), stock: { code: "600519", name: "贵州茅台" },
    condition: { field: "changePct", op: "gte", value: 5 }, conditionHit: { at: iso("2026-11-12T10:00:00"), detail: "贵州茅台 涨跌幅 +5.2%，已涨超 5%" } }] }).notes;
  const text = model.aiQuestion(note, cn("2026-11-12T10:01:00"));
  assert.match(text, /「涨超5%就卖一半」/);
  assert.match(text, /贵州茅台 600519/);
  assert.match(text, /已经触发：贵州茅台 涨跌幅 \+5\.2%/);
  assert.match(text, /现在是 2026-11-12 10:01/);
  assert.match(text, /记于 2026-11-12 09:00/);
});

test("交易时段：交易日 9:30–11:30、13:00–15:00", () => {
  assert.equal(model.inTradingSession(cn("2026-11-12T10:00:00")), true);
  assert.equal(model.inTradingSession(cn("2026-11-12T12:00:00")), false);
  assert.equal(model.inTradingSession(cn("2026-11-12T15:30:00")), false);
  assert.equal(model.inTradingSession(cn("2026-11-14T10:00:00")), false, "周六");
});

test("盘前盘后偏移按实际开收盘计算，重复和周末顺延保留", () => {
  const friday = cn("2026-11-13T16:00:00");
  const cases = [
    ["每个交易日开盘前半小时提醒我看 600519", "2026-11-16T09:00:00", "tradingDays"],
    ["明天开盘十分钟后看分时", "2026-11-16T09:40:00", "none"],
    ["下周一下午开盘后５分钟查看", "2026-11-16T13:05:00", "none"],
    ["下周一收盘前一刻钟复核", "2026-11-16T14:45:00", "none"],
    ["11月20日收盘后十五分钟复盘", "2026-11-20T15:15:00", "none"],
    ["一个半小时后提醒我复盘", "2026-11-13T17:30:00", "none"],
  ];
  for (const [text, expected, repeat] of cases) {
    const parsed = model.parseRemind(text, friday);
    assert.equal(parsed?.at, cn(expected), text);
    assert.equal(parsed?.repeat, repeat, text);
  }
});

test("无效日期和钟点明确提示，多个股票或价格条件不会只偷偷取第一项", () => {
  for (const text of ["11月31日 14:30 复核", "明天 25:00 复盘", "明天 14:75 复盘", "2026-02-30 10:00 看看"]) {
    assert.ok(model.inspectReminder(text, NOW)?.problem, text);
    assert.equal(model.parseRemind(text, NOW), null);
  }
  assert.equal(model.parseRemind("2027-01-08 10:30 复核", NOW)?.at, cn("2027-01-08T10:30:00"));
  assert.equal(model.parseRemind("2028年1月8日 10:30 复核", NOW)?.at, cn("2028-01-08T10:30:00"));
  assert.equal(model.parseRemind("600519 10分钟后看", NOW)?.at, NOW + 600_000);
  assert.deepEqual(model.detectStockCodes("关注 002594 和 600519，再看 002594"), ["002594", "600519"]);
  assert.deepEqual(model.parseConditions("跌破 10 止损，涨幅超过 5% 时看"), [
    { field: "latest", op: "lte", value: 10 }, { field: "changePct", op: "gte", value: 5 },
  ]);
  assert.equal(model.parseConditions("跌破5日线，跌破10时再看，跌破10时提醒").length, 1);
  assert.equal(model.parseConditions("不跌破10才继续观察").length, 0);
});

test("识别分钟循环，恢复后保持原频率且不连发积压提醒", () => {
  for (const text of ["每十五分钟提醒我一次", "每隔 15 分钟提醒我一次", "提醒我每十五分钟看一下"]) {
    const parsed = model.parseRemind(text, NOW);
    assert.equal(parsed?.repeat, "interval", text);
    assert.equal(parsed?.intervalMinutes, 15);
    assert.equal(parsed?.at, NOW + 15 * 60_000);
  }
  assert.equal(model.parseRemind("十五分钟后提醒我一次", NOW).repeat, "none");
  assert.equal(model.parseRemind("K线每十五分钟更新一次", NOW), null);
  assert.equal(model.parseRemind("每十五分钟内涨超过3%要观察", NOW), null);
  assert.equal(model.parseRemind("不用每十五分钟提醒我", NOW), null);
  assert.match(model.inspectReminder("每0分钟提醒我", NOW).problem, /1.*1440/);
  const note = model.normalizeNote({ id: "loop", text: "循环", remindAt: new Date(NOW).toISOString(), repeat: "interval", intervalMinutes: 15 });
  assert.equal(note.intervalMinutes, 15);
  const fired = model.markFired(note, NOW + 31 * 60_000);
  assert.equal(Date.parse(fired.remindAt), NOW + 45 * 60_000);
  assert.equal(model.dueToFire([fired], NOW + 44 * 60_000).length, 0);
  assert.equal(model.dueToFire([fired], NOW + 45 * 60_000).length, 1);
  assert.equal(model.normalizeNote({ ...note, intervalMinutes: 0 }).repeat, "none");
});

test("分钟循环的日期限制不会被默默当成一次性或全天提醒", () => {
  for (const text of [
    "今天每十五分钟提醒我一次",
    "今天，每十五分钟提醒我一次",
    "从14:30起每15分钟提醒我一次",
    "盘中每隔15分钟提醒我一次",
    "每十五分钟提醒我一次，到收盘为止",
    "每隔15分钟，提醒我休息",
    "请帮我每15分钟提醒我一次"
  ]) {
    const result = model.inspectReminder(text, NOW);
    if (/今天|盘中|为止|14:30/.test(text)) assert.match(result?.problem, /日期|时段/, text);
    else assert.equal(result?.intervalMinutes, 15, text);
  }
  assert.equal(model.parseRemind("每15分钟提醒我检查盘中成交量", NOW)?.intervalMinutes, 15);
  assert.equal(model.parseRemind("不用每15分钟提醒我", NOW), null);
});

test("useNotes askAi guards cleared ai state and syncIntervals avoids empty-list spam", async () => {
  const { createHookHarness } = require("../../../qa/research-hook-harness.cjs");
  const { useNotes } = require("./useNotes.ts");
  let resolveStart;
  const origWindow = globalThis.window;
  const origDocument = globalThis.document;
  let intervalSyncCalls = 0;
  globalThis.document = {
    ...(origDocument || {}),
    visibilityState: "visible",
    addEventListener: () => {},
    removeEventListener: () => {}
  };
  globalThis.window = {
    ...(origWindow || {}),
    setInterval: () => 1,
    clearInterval: () => {},
    setTimeout: () => 1,
    clearTimeout: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    stockApi: {
      kvGet: async () => null,
      kvSet: async () => true,
      syncNoteConditions: async () => ({ watching: 0, session: false, hits: [] }),
      syncNoteIntervals: async () => { intervalSyncCalls += 1; return { ok: true }; },
      ai: {
        agent: {
          start: () => new Promise(resolve => { resolveStart = resolve; }),
          poll: async () => ({ done: true, status: "done", answer: "结论：偏多" })
        }
      }
    }
  };
  const h = createHookHarness(() => useNotes());
  try {
    h.render();
    h.tree.add({ text: "测试随心记 600519" });
    await h.flush();
    const noteId = h.tree.store.notes[0].id;
    const askPromise = h.tree.askAi(noteId);
    h.tree.clearAi(noteId);
    resolveStart({ runId: "run-1" });
    await askPromise;
    await h.flush();
    assert.equal(h.tree.store.notes[0].ai, null, "clearAi while start pending must not be overwritten");
    assert.ok(intervalSyncCalls <= 1, "empty-list interval sync is deduplicated");
    h.tree.update(noteId, { text: "更新随心记 600519" });
    h.tree.later(noteId, 5);
    h.tree.rearm(noteId);
    h.tree.setVoice(false);
    h.tree.setSystemNotify(true);
    h.tree.setAiAuto(false);
    h.tree.dismiss();
    h.tree.clearDone();
    h.tree.remove(noteId);
    await h.flush();
    h.tree.add({ text: "完成态测试 000001" });
    await h.flush();
    const id2 = h.tree.store.notes[0].id;
    const p2 = h.tree.askAi(id2);
    resolveStart({ conversationId: "c1", runId: "r1" });
    await p2;
    await h.flush();
    h.tree.update(id2, { done: true });
    h.tree.clearDone();
    await h.flush();
    h.tree.add({ text: "失败态测试 600000" });
    await h.flush();
    const id3 = h.tree.store.notes[0].id;
    let rejectStart;
    globalThis.window.stockApi.ai.agent.start = () => new Promise((_, reject) => { rejectStart = reject; });
    const p3 = h.tree.askAi(id3);
    rejectStart(new Error("agent offline"));
    await p3;
    await h.flush();
    h.tree.remove(id3);
    await h.flush();
  } finally {
    h.dispose();
    if (origWindow === undefined) delete globalThis.window;
    else globalThis.window = origWindow;
    if (origDocument === undefined) delete globalThis.document;
    else globalThis.document = origDocument;
  }
});

test("盘中做T、盯盘这类随心记默认只在盘中提醒；盘前、复盘类不算", () => {
  for (const text of ["盘中做T注意关键词", "600519 做t 高抛低吸", "明天盯盘看分时", "T+0 冲高减仓"]) assert.equal(model.isIntradayText(text), true, text);
  for (const text of ["明天开盘前看一下茅台", "收盘后复盘", "周末看研报", "Tesla 财报", "收盘后复盘今天冲高回落的票", "盘后看龙虎榜和炸板股", "晚上8点复盘：打板失败原因", "周末整理分时图笔记", "明早9:15挂单 600519", "冲高回落就减仓"]) assert.equal(model.isIntradayText(text), false, text);
  const legacy = model.normalizeNote({ id: "a", text: "提醒盘中做T注意关键词", createdAt: iso("2026-11-12T09:00:00"), remindAt: iso("2026-11-12T20:00:00"), repeat: "interval", intervalMinutes: 30 });
  assert.equal(legacy.sessionOnly, true, "old notes about 盘中做T switch to session-only automatically");
  assert.equal(model.normalizeNote({ id: "b", text: "提醒盘中做T", sessionOnly: false, createdAt: iso("2026-11-12T09:00:00") }).sessionOnly, false, "an explicit choice is kept");
});

test("下一个盘中时点：盘中原样、午休到 13:00、收盘后和周末到下一个交易日 9:30", () => {
  const next = text => new Date(model.nextSessionMoment(cn(text))).toISOString();
  assert.equal(next("2026-11-12T10:00:00"), iso("2026-11-12T10:00:00"));
  assert.equal(next("2026-11-12T08:10:00"), iso("2026-11-12T09:30:00"));
  assert.equal(next("2026-11-12T12:05:00"), iso("2026-11-12T13:00:00"));
  assert.equal(next("2026-11-12T20:00:00"), iso("2026-11-13T09:30:00"));
  assert.equal(next("2026-11-13T15:30:00"), iso("2026-11-16T09:30:00"), "Friday evening → Monday open");
});

test("只在盘中提醒的随心记：盘外到点不提醒而是顺延；按分钟重复跳过午休和收盘", () => {
  const base = { id: "t", text: "盘中做T注意关键词", createdAt: iso("2026-11-12T09:00:00"), updatedAt: iso("2026-11-12T09:00:00"), stock: null, done: false, firedFor: null, lastFiredAt: null, condition: null, conditionHit: null, ai: null };
  const night = { ...base, remindAt: iso("2026-11-12T20:00:00"), repeat: "interval", intervalMinutes: 30, sessionOnly: true };
  assert.deepEqual(model.dueToFire([night], cn("2026-11-12T20:00:30")), [], "no reminder at 20:00");
  assert.deepEqual(model.deferOutOfSession([night], cn("2026-11-12T20:00:30")), [{ id: "t", remindAt: iso("2026-11-13T09:30:00") }]);
  const anyTime = { ...night, sessionOnly: false };
  assert.equal(model.dueToFire([anyTime], cn("2026-11-12T20:00:30")).length, 1, "normal notes still remind at night");
  assert.deepEqual(model.deferOutOfSession([anyTime], cn("2026-11-12T20:00:30")), []);
  const morning = { ...night, remindAt: iso("2026-11-13T11:15:00") };
  assert.equal(model.dueToFire([morning], cn("2026-11-13T11:15:10")).length, 1, "in session it fires");
  assert.equal(model.markFired(morning, cn("2026-11-13T11:15:10")).remindAt, iso("2026-11-13T13:00:00"), "11:45 falls in the lunch break → 13:00");
  const close = { ...night, remindAt: iso("2026-11-13T14:50:00") };
  assert.equal(model.markFired(close, cn("2026-11-13T14:50:05")).remindAt, iso("2026-11-16T09:30:00"), "after the close → next trading day open");
  const daily = { ...base, remindAt: iso("2026-11-13T21:00:00"), repeat: "daily", intervalMinutes: null, sessionOnly: true };
  assert.equal(model.markFired(daily, cn("2026-11-13T21:00:05")).remindAt, iso("2026-11-16T09:30:00"));
});
