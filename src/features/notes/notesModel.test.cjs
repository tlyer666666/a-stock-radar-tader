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
