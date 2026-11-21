"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

const restoreTypeScript = registerTypeScript();
const { ecologyRefreshNotice } = require("./LimitEcologyPanel.tsx");
after(restoreTypeScript);

const at = new Date("2026-11-19T06:30:05Z");
const base = { available: true, fetchedAt: "2026-11-19T06:29:00Z", dragonTiger: { date: "2026-11-19", count: 60, topNet: [], desks: [] }, warnings: [] };

test("a manual refresh with identical data says the source has nothing new instead of looking broken", () => {
  assert.equal(ecologyRefreshNotice({ ...base, fetchedAt: "2026-11-19T06:30:00Z" }, base, at), "14:30:05 已刷新，数据源暂无新数据");
});

test("a manual refresh with a new dragon-tiger list reports the update", () => {
  const next = { ...base, dragonTiger: { ...base.dragonTiger, count: 61 } };
  assert.equal(ecologyRefreshNotice(next, base, at), "14:30:05 已刷新，数据有更新");
});

test("blocks that fell back to earlier data are called out", () => {
  const next = { ...base, warnings: ["龙虎榜本次刷新失败，沿用 14:20 的数据（限流）"] };
  assert.match(ecologyRefreshNotice(next, base, at), /1 个分块本次没取到，沿用之前的数据/);
});
