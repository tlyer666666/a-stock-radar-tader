"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let App;
let restoreTypeScript;
let previousCssLoader;
let previousWindow;

before(() => {
  previousCssLoader = require.extensions[".css"];
  require.extensions[".css"] = () => {};
  previousWindow = global.window;
  global.window = { stockApi: {} };
  restoreTypeScript = registerTypeScript();
  App = require("./App.tsx").default;
});

after(() => {
  restoreTypeScript?.();
  if (previousCssLoader) require.extensions[".css"] = previousCssLoader;
  else delete require.extensions[".css"];
  if (previousWindow === undefined) delete global.window;
  else global.window = previousWindow;
});

test("renderer initial shell exposes navigation, window controls and risk notice", () => {
  const html = renderToStaticMarkup(React.createElement(App));

  assert.match(html, /class="app-shell"/);
  assert.match(html, /data-window-controls="true"/);
  assert.match(html, /aria-label="最小化窗口"/);
  assert.match(html, /aria-label="最大化窗口"/);
  assert.match(html, /aria-label="关闭窗口"/);
  assert.match(html, /data-window-action="minimize"/);
  assert.match(html, /data-window-action="toggle-maximize"/);
  assert.match(html, /data-window-action="close"/);
  assert.match(html, /aria-label="证券搜索：A股、ETF、可转债"/);
  assert.match(html, /data-professional-review-nav="true"/);
  assert.match(html, /data-announcements-nav="true"/);
  assert.match(html, /data-backtest-nav="true"/);
  assert.match(html, /专业复盘/);
  assert.match(html, /仅供研究，不构成投资建议/);
  assert.ok((html.match(/class="nav-item/g) || []).length >= 9);
});
