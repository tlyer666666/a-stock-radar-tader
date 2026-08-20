"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let InlineDecisionBar;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  InlineDecisionBar = require("./InlineDecisionBar.tsx").default;
});

after(() => restoreTypeScript?.());

test("inline decision exposes a non-modal accessible confirmation", () => {
  const html = renderToStaticMarkup(React.createElement(InlineDecisionBar, {
    prompt: {
      id: "risk-review",
      title: "确认模拟下单",
      description: "当前信号需要人工复核。",
      details: ["行情质量待确认"],
      confirmLabel: "继续",
      cancelLabel: "取消"
    },
    onConfirm() {},
    onCancel() {}
  }));

  assert.match(html, /role="alertdialog"/);
  assert.match(html, /aria-modal="false"/);
  assert.match(html, /确认模拟下单/);
  assert.match(html, /行情质量待确认/);
  assert.match(html, />继续</);
  assert.match(html, />取消</);
});
