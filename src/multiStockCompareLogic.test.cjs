"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let logic;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  logic = require("./multiStockCompareLogic.ts");
});

after(() => restoreTypeScript?.());

const a = { code: "000001", name: "平安银行", secid: "0.000001" };
const b = { code: "000002", name: "万科A", secid: "0.000002" };

test("a new request generation retakes every selected stock without a payload", () => {
  const targets = logic.selectCompareTargets([a, b], {
    [a.code]: { loading: true, payload: null },
    [b.code]: { loading: false, payload: { quote: {} } }
  }, false);

  assert.deepEqual(targets.map((item) => item.code), [a.code]);
  assert.deepEqual(
    logic.selectCompareTargets([a, b], {}, true).map((item) => item.code),
    [a.code, b.code]
  );
});

test("fallback keeps a quote when the chart request fails", async () => {
  const payload = await logic.loadComparePayload(a, {
    analyze: async () => { throw new Error("analysis limited"); },
    getQuoteSnapshot: async () => ({
      security: a,
      quote: { latest: 12.3 },
      actualProvider: "ths"
    }),
    getChart: async () => { throw new Error("chart limited"); }
  });

  assert.equal(payload.quote.latest, 12.3);
  assert.deepEqual(payload.history, []);
  assert.match(payload.analysis.risks.join(" "), /chart limited/);
});

test("fallback keeps chart history when the quote request fails", async () => {
  const payload = await logic.loadComparePayload(b, {
    analyze: async () => { throw new Error("analysis unavailable"); },
    getQuoteSnapshot: async () => { throw new Error("quote unavailable"); },
    getChart: async () => ({
      rows: [{ close: 10 }, { close: 11 }],
      source: "eastmoney",
      updatedAt: "2026-08-20T00:00:00.000Z"
    })
  });

  assert.equal(payload.history.length, 2);
  assert.deepEqual(payload.quote, {});
  assert.equal(payload.actualProvider, "eastmoney");
});

test("fallback reports an error only when both basic sources fail", async () => {
  await assert.rejects(
    logic.loadComparePayload(a, {
      analyze: async () => { throw new Error("analysis unavailable"); },
      getQuoteSnapshot: async () => { throw new Error("quote unavailable"); },
      getChart: async () => { throw new Error("chart unavailable"); }
    }),
    /quote unavailable.*chart unavailable/
  );
});
