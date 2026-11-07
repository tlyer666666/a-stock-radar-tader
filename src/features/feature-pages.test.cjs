"use strict";

const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../qa/register-typescript.cjs");

const previousCssLoader = require.extensions[".css"];
require.extensions[".css"] = () => {};
const restoreTypeScript = registerTypeScript();

const { NewsView } = require("./information/NewsView.tsx");
const { informationTabs, resolveInformationCenterRoute } = require("./information/informationModel.ts");
const { SettingsView } = require("./settings/SettingsView.tsx");
const { initialSettings } = require("../domain/settings.ts");

test("information feature keeps the three content routes and legacy announcement mapping", () => {
  assert.deepEqual(informationTabs.map((tab) => tab.id), ["all", "flash", "announcement"]);
  assert.deepEqual(resolveInformationCenterRoute("news"), { view: "news", informationTab: "all" });
  assert.deepEqual(resolveInformationCenterRoute("announcements"), { view: "news", informationTab: "announcement" });
  assert.deepEqual(resolveInformationCenterRoute("news", "flash"), { view: "news", informationTab: "flash" });
});

test("information feature preserves page title, tabs, refresh controls, and source separation", () => {
  const markup = renderToStaticMarkup(React.createElement(NewsView, {
    payload: null,
    watchlist: [],
    holdings: [],
    limitUps: [],
    settings: initialSettings,
    onContentTypeChange() {},
    onOpenStock() {}
  }));

  for (const marker of ["资讯中心", "role=\"tablist\" aria-label=\"资讯类型\"", "市场资讯", "公司公告", "自动刷新中", "信息判定规则"]) {
    assert.ok(markup.includes(marker), `missing information page marker: ${marker}`);
  }
});

test("settings feature preserves all four settings groups and safe-save messaging", () => {
  const markup = renderToStaticMarkup(React.createElement(SettingsView, {
    value: initialSettings,
    loadState: "ready",
    onSave: async (next) => ({ ...initialSettings, ...next })
  }));

  for (const marker of ["数据源设置", "行情连接", "监控与提醒", "执行参数", "策略组合", "保存设置"]) {
    assert.ok(markup.includes(marker), `missing settings page marker: ${marker}`);
  }
  assert.match(markup, /aria-label="设置分类"/);
});

after(() => {
  restoreTypeScript?.();
  if (previousCssLoader) require.extensions[".css"] = previousCssLoader;
  else delete require.extensions[".css"];
});
