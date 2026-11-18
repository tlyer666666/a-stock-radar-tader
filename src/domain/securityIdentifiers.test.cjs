"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { registerTypeScript } = require("../../qa/register-typescript.cjs");

registerTypeScript();

const {
  inferExchange,
  inferSecid,
  inferAssetType,
  inferSecurityMeta
} = require("./securityIdentifiers.ts");

test("securityIdentifiers classifies SH/SZ/BJ stocks, B-shares, ETFs, and convertibles canonically", () => {
  assert.equal(inferSecid("600519"), "1.600519");
  assert.equal(inferSecid("688981"), "1.688981");
  assert.equal(inferSecid("689009"), "1.689009");
  assert.equal(inferSecid("900901"), "1.900901");
  assert.equal(inferSecid("510300"), "1.510300");
  assert.equal(inferSecid("113050"), "1.113050");

  assert.equal(inferSecid("920001"), "0.920001");
  assert.equal(inferExchange("920001"), "BJ");
  assert.equal(inferSecid("830799"), "0.830799");
  assert.equal(inferExchange("830799"), "BJ");

  assert.equal(inferSecid("000001"), "0.000001");
  assert.equal(inferSecid("300750"), "0.300750");
  assert.equal(inferSecid("159915"), "0.159915");
  assert.equal(inferSecid("127085"), "0.127085");

  assert.equal(inferAssetType("510300"), "etf");
  assert.equal(inferAssetType("159915"), "etf");
  assert.equal(inferAssetType("113050"), "convertibleBond");
  assert.equal(inferAssetType("127085"), "convertibleBond");
  assert.equal(inferAssetType("920001"), "stock");

  assert.deepEqual(inferSecurityMeta("689009"), {
    code: "689009",
    name: "689009",
    secid: "1.689009",
    thscode: "689009.SH",
    marketName: "科创板",
    assetType: "stock"
  });
  assert.equal(inferSecurityMeta("113050").thscode, "113050.SH");
  assert.equal(inferSecurityMeta("920001").thscode, "920001.BJ");
});
