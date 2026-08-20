"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let FilterChipGroup;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  FilterChipGroup = require("./FilterChipGroup.tsx").default;
});

after(() => restoreTypeScript?.());

test("filter chip group exposes its label and selected state", () => {
  const html = renderToStaticMarkup(React.createElement(FilterChipGroup, {
    label: "公告方向",
    icon: React.createElement("span", null, "icon"),
    options: [
      { id: "all", label: "全部" },
      { id: "risk", label: "风险" }
    ],
    value: "risk",
    onChange() {}
  }));

  assert.match(html, /role="group"/);
  assert.match(html, /aria-label="公告方向"/);
  assert.match(html, /aria-pressed="true"[^>]*>风险/);
  assert.match(html, /aria-pressed="false"[^>]*>全部/);
});
