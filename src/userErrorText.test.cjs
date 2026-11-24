"use strict";
const assert = require("node:assert/strict");
const { before, after, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
let mod, restore;
before(() => { restore = registerTypeScript(); mod = require("./userErrorText.ts"); });
after(() => restore?.());

test("IPC error codes and Electron wrappers are stripped from what the user reads", () => {
  assert.equal(mod.userErrorText(new Error("[IPC_FAILED] 操作失败，请稍后再试")), "操作失败，请稍后再试");
  assert.equal(mod.userErrorText(new Error("[SERVICE_BUSY] 后台任务较多，请稍后再试（可重试）")), "后台任务较多，请稍后再试（可重试）");
  assert.equal(mod.userErrorText(new Error("Error invoking remote method 'bond:list': Error: [JOB_TIMEOUT] 读取超时")), "读取超时");
  assert.equal(mod.userErrorText(new Error("同花顺接口暂时不可用")), "同花顺接口暂时不可用");
});

test("non-Error reasons keep the caller's fallback or their own text", () => {
  assert.equal(mod.userErrorText(null, "涨停池更新失败"), "涨停池更新失败");
  assert.equal(mod.userErrorText("raw text"), "raw text");
  assert.equal(mod.userErrorText(new Error("[IPC_FAILED]"), "涨停池更新失败"), "涨停池更新失败");
  assert.equal(mod.userErrorText({}), "操作失败，请稍后再试");
  assert.equal(mod.userErrorText(undefined), "操作失败，请稍后再试");
  assert.equal(mod.userErrorText(null), "操作失败，请稍后再试");
  assert.equal(mod.userErrorText({ message: "[IPC_FAILED] 读取失败" }), "读取失败");
  assert.equal(mod.userErrorText({ message: "" }, "自定义兜底"), "自定义兜底");
});
