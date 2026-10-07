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

test('saved stock-review dates use the Shanghai day of the snapshot, with a valid current-day fallback', () => {
  // Exercise the actual UI save handler, not a duplicate date expression.
  const fs = require('node:fs');
  const ts = require('typescript');
  const source = fs.readFileSync(require.resolve('./ProfessionalReview.tsx'), 'utf8');
  const tree = ts.createSourceFile('ProfessionalReview.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let initializer;
  const visit = node => { if (ts.isVariableDeclaration(node) && node.name.getText(tree) === 'saveStockReview') initializer = node.initializer.getText(tree); ts.forEachChild(node, visit); };
  visit(tree); assert.ok(initializer);
  const handlerCode = ts.transpileModule(`const save = ${initializer}; save();`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  const current = new Date('2026-10-01T16:30:00Z');
  class FixtureDate extends Date { constructor(...args) { super(...(args.length ? args : [current.getTime()])); } static now() { return current.getTime(); } }
  for (const [updatedAt, expected] of [['2026-09-30T16:30:00Z','2026-10-01'],['invalid','2026-10-02'],[undefined,'2026-10-02']]) {
    let saved;
    require('node:vm').runInNewContext(handlerCode, {Date:FixtureDate, stock:{security:{code:'600000',name:'合成'},updatedAt,score:50,verdict:'观察'}, stockNote:'合成备注', archive:[], persistArchive:next=>{saved=next;return true;}, setStockNote:()=>{}, notify:()=>{}, shanghaiDateTagFrom:dateUtils.shanghaiDateTagFrom});
    assert.equal(saved[0].date, expected);
  }
});
