"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");

let restoreTypeScript;
let panel;
before(() => { restoreTypeScript = registerTypeScript(); panel = require("./FeedsPanel.tsx"); });
after(() => restoreTypeScript?.());

test("validateFeedUrl accepts valid https URLs and explains http or whitespace mistakes", () => {
  assert.deepEqual(panel.validateFeedUrl("https://example.com/rss.xml"), { ok: true, hint: "" });
  assert.deepEqual(panel.validateFeedUrl("  https://example.com/rss.xml  "), { ok: true, hint: "" });
  assert.equal(panel.validateFeedUrl("").ok, false);
  assert.equal(panel.validateFeedUrl("").hint, "");

  const httpRes = panel.validateFeedUrl("http://example.com/rss.xml");
  assert.equal(httpRes.ok, false);
  assert.match(httpRes.hint, /仅支持 https/);

  const spacedRes = panel.validateFeedUrl("https://example.com/rss.xml extra");
  assert.equal(spacedRes.ok, false);
  assert.match(spacedRes.hint, /不能包含空格/);

  const badHost = panel.validateFeedUrl("https://localhost/rss");
  assert.equal(badHost.ok, false);
  assert.match(badHost.hint, /有效的 https/);
});

test("FeedsPanelView renders empty state, feed list with accessible labels, URL hints and alerts", () => {
  const empty = renderToStaticMarkup(React.createElement(panel.FeedsPanelView, {
    state: { feeds: [], maxFeeds: 12 }, busy: false, message: "", onCall() {}
  }));
  assert.match(empty, /还没有添加资讯源/);
  assert.match(empty, /最多 12 个/);

  const httpHint = renderToStaticMarkup(React.createElement(panel.FeedsPanelView, {
    state: { feeds: [], maxFeeds: 12 }, busy: false, message: "", initialUrl: "http://example.com/feed.xml", onCall() {}
  }));
  assert.match(httpHint, /role="alert"[^>]*>仅支持 https:\/\/ 开头的资讯源地址/);

  const spacedHint = renderToStaticMarkup(React.createElement(panel.FeedsPanelView, {
    state: { feeds: [], maxFeeds: 12 }, busy: false, message: "", initialUrl: "https://example.com/feed.xml junk", onCall() {}
  }));
  assert.match(spacedHint, /role="alert"[^>]*>地址不能包含空格/);

  const listed = renderToStaticMarkup(React.createElement(panel.FeedsPanelView, {
    state: {
      feeds: [
        { id: "f1", name: "财经观察", url: "https://example.com/finance.xml", enabled: true },
        { id: "f2", name: "行业简报", url: "https://example.com/industry.xml", enabled: false }
      ],
      maxFeeds: 12
    },
    busy: false,
    message: "能读到 5 条",
    error: "抓取超时",
    onCall() {}
  }));
  for (const text of ["财经观察", "https://example.com/finance.xml", "行业简报", "能读到 5 条", "抓取超时"]) {
    assert.ok(listed.includes(text), text);
  }
  assert.match(listed, /aria-label="暂停资讯源：财经观察"/);
  assert.match(listed, /aria-label="启用资讯源：行业简报"/);
  assert.match(listed, /role="alert"[^>]*>抓取超时/);
  assert.match(listed, /role="status"[^>]*>能读到 5 条/);
});
