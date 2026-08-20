"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let logic;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  logic = require("./portfolioBacktestLogic.ts");
});

after(() => restoreTypeScript?.());

const stock = (code, score = 70) => ({ code, name: code, signalScore: score });
const published = (id, stocks) => ({
  id,
  name: id,
  publicationAccepted: true,
  validation: { accepted: true },
  stocks
});

test("strategy universe blocks missing and publication-rejected strategies", () => {
  assert.throws(
    () => logic.resolvePublishedStrategyUniverse(
      { strategies: [published("a", [stock("000001")])] },
      ["a", "missing"],
      1
    ),
    /策略服务未返回.*missing/
  );

  assert.throws(
    () => logic.resolvePublishedStrategyUniverse(
      {
        strategies: [{
          id: "blocked",
          name: "未发布策略",
          publicationAccepted: false,
          validation: { accepted: true },
          stocks: [stock("000002")]
        }]
      },
      ["blocked"],
      1
    ),
    /未通过发布复核.*未发布策略/
  );
});

test("strategy universe keeps the requested vote threshold exactly", () => {
  const report = {
    strategies: [
      published("a", [stock("000001", 80), stock("000002", 60)]),
      published("b", [stock("000001", 85), stock("000002", 70)]),
      published("c", [stock("000002", 90)])
    ]
  };
  const selection = logic.resolvePublishedStrategyUniverse(report, ["a", "b", "c"], 3);

  assert.deepEqual(selection.candidates.map((item) => item.code), ["000002"]);
  assert.equal(selection.candidates[0].strategyVotes, 3);
});

test("entry strategy metadata is reused only for the unchanged strategy signature", () => {
  const context = { strategyIds: ["a", "b"], minimumVotes: 2 };

  assert.equal(logic.matchesInitialStrategySignature(context, ["b", "a"], 2), true);
  assert.equal(logic.matchesInitialStrategySignature(context, ["a"], 1), false);
  assert.equal(logic.matchesInitialStrategySignature(context, ["a", "b"], 1), false);
});
