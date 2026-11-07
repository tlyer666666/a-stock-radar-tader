"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let dateUtils;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  dateUtils = require("./dateUtils.ts");
});

after(() => restoreTypeScript?.());

test("Shanghai date remains on the local trading day across the UTC boundary", () => {
  assert.equal(dateUtils.shanghaiDateTag(new Date("2026-08-12T15:59:59Z")), "2026-08-12");
  assert.equal(dateUtils.shanghaiDateTag(new Date("2026-08-12T16:00:00Z")), "2026-08-13");
});

test("backtest defaults shift calendar years without using the runner timezone", () => {
  assert.equal(dateUtils.shiftShanghaiDate(-1, new Date("2026-08-12T16:30:00Z")), "2025-08-13");
  assert.equal(dateUtils.shiftShanghaiDate(-1, new Date("2024-02-29T04:00:00Z")), "2023-02-28");
});

test('saved stock-review dates use the Shanghai day of the snapshot, with a valid current-day fallback', async () => {
  // Exercise the actual UI save handler, not a duplicate date expression.
  const fs = require('node:fs');
  const ts = require('typescript');
  const source = fs.readFileSync(require.resolve('./ProfessionalReview.tsx'), 'utf8');
  const tree = ts.createSourceFile('ProfessionalReview.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'saveStockReview') initializer = node.initializer.getText(tree); ts.forEachChild(node, visit); };
  visit(tree); assert.ok(initializer);
  const handlerCode = ts.transpileModule(`const save = ${initializer}; save();`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const current = new Date('2026-10-02T02:30:00Z');
  class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [current.getTime()])); } static now() { return current.getTime(); } }
  for (const [updatedAt, expected] of [['2026-09-30T16:30:00Z','2026-10-01'],['invalid','2026-10-02'],[undefined,'2026-10-02']]) {
    let saved;
    const task = require('node:vm').runInNewContext(handlerCode, {Date:FixtureDate, stock:{security:{code:'600000',name:'合成'},updatedAt,score:50,verdict:'观察'}, stockNote:'合成备注', persistArchive:record=>{saved=record;return true;}, setStockNote:()=>{}, notify:()=>{}, shanghaiDateTagFrom:dateUtils.shanghaiDateTagFrom, previewMode:false, isPreviewReviewSnapshot:()=>false});
    await task;
    assert.equal(saved.date, expected);
  }
});

// ── B-04：展示时间固定北京时间（不跟随系统时区） ─────────────────────────────
test("market times render in Asia/Shanghai even when the process timezone is elsewhere", () => {
  const original = process.env.TZ;
  try {
    process.env.TZ = "America/New_York";
    // 对照：裸 toLocale* 跟随系统时区（纽约 11:59:59），这正是 B-04 修掉的写法。
    assert.equal(new Date("2026-08-12T15:59:59Z").toLocaleTimeString("zh-CN", { hour12: false }), "11:59:59");
    assert.equal(dateUtils.formatShanghaiTime("2026-08-12T15:59:59Z"), "23:59:59");
    assert.equal(dateUtils.formatShanghaiDateTime("2026-08-12T16:00:00Z"), "2026/08/13 00:00:00");
    assert.equal(dateUtils.formatShanghaiDate("2026-08-12T16:00:00Z"), "2026-08-13");
    assert.equal(dateUtils.shanghaiDateTag(new Date("2026-08-12T16:00:00Z")), "2026-08-13");
  } finally {
    if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
  }
});

// ── B-11：非法时间戳统一兜底，不再渲染 Invalid Date ─────────────────────────
test("invalid or missing timestamps fall back instead of rendering Invalid Date", () => {
  for (const bad of ["invalid", "", undefined, null, "2026-13-45T99:99:99Z", Number.NaN]) {
    assert.equal(dateUtils.formatShanghaiTime(bad), "--", `time ${String(bad)}`);
    assert.equal(dateUtils.formatShanghaiDateTime(bad), "--", `dateTime ${String(bad)}`);
    assert.equal(dateUtils.formatShanghaiDate(bad), "--", `date ${String(bad)}`);
  }
  assert.equal(dateUtils.formatShanghaiTime("invalid", "时间待确认"), "时间待确认");
  assert.equal(dateUtils.formatShanghaiDateTime("2026-08-12T16:00:00Z"), "2026/08/13 00:00:00");
});

test("快讯时间：带时区的换算成北京时间，不带时区的原样截取", () => {
  assert.equal(dateUtils.newsTimeText("2026-11-06T23:30:00Z"), "11-07 07:30");
  assert.equal(dateUtils.newsTimeText("2026-11-07 09:31:05"), "11-07 09:31");
  assert.equal(dateUtils.newsTimeText(""), "--");
});
