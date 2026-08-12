"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let restoreTypeScript;
let ProfessionalReview;
let FACTOR_GROUPS;

before(() => {
  restoreTypeScript = registerTypeScript();
  ({ default: ProfessionalReview, FACTOR_GROUPS } = require("./ProfessionalReview.tsx"));
});

test("professional stock review keeps the complete five-group twenty-factor contract", () => {
  assert.equal(FACTOR_GROUPS.length, 5);
  const factors = FACTOR_GROUPS.flatMap((group) => group.factors);
  assert.equal(factors.length, 20);
  assert.equal(new Set(factors).size, factors.length);
});

after(() => restoreTypeScript?.());

test("professional review renders its critical navigation shell", () => {
  const html = renderToStaticMarkup(React.createElement(ProfessionalReview));
  assert.match(html, /<h1>专业复盘<\/h1>/);
  assert.match(html, /市场复盘/);
  assert.match(html, /个股复盘/);
  assert.match(html, /复盘档案 0/);
  assert.match(html, /aria-label="专业复盘页面"/);
  assert.equal((html.match(/role="tab"/g) || []).length, 3);
  assert.equal((html.match(/aria-selected="true"/g) || []).length, 1);
  assert.match(html, /重新计算/);
});
