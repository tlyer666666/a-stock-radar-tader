"use strict";

const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");

let logic;
let restoreTypeScript;

before(() => {
  restoreTypeScript = registerTypeScript();
  logic = require("./watchlistLogic.ts");
});

after(() => restoreTypeScript?.());

const observedFavorite = {
  code: "000001",
  name: "平安银行",
  secid: "0.000001",
  createdAt: "2026-08-01T00:00:00.000Z",
  favoriteAddedAt: "2026-08-02T00:00:00.000Z",
  favorite: true,
  autoAdded: true,
  limitDate: "2026-08-10",
  tradingDaysSince: 6,
  observationNode: "T+6",
  note: "涨停后第 6 个交易日 · 2026-08-10"
};

test("removing an observation preserves its favorite identity but clears observation state", () => {
  const result = logic.removeObservationFromWatchlist([observedFavorite], observedFavorite.code);

  assert.equal(result.length, 1);
  assert.equal(result[0].favorite, true);
  assert.equal(result[0].autoAdded, false);
  assert.equal(result[0].observationNode, undefined);
  assert.equal(result[0].tradingDaysSince, undefined);
});

test("a local exclusion prevents the same limit-up event from being merged back", () => {
  const favoriteOnly = logic.removeObservationFromWatchlist(
    [observedFavorite],
    observedFavorite.code
  );
  const exclusions = logic.upsertObservationExclusion(
    [],
    observedFavorite,
    new Date().toISOString()
  );
  const sameEvent = {
    ...observedFavorite,
    favorite: false,
    tradingDaysSince: 7
  };
  const merged = logic.mergeObservationPool(favoriteOnly, [sameEvent], exclusions);

  assert.equal(merged.length, 1);
  assert.equal(merged[0].favorite, true);
  assert.equal(merged[0].autoAdded, false);
});

test("a later distinct limit-up event may enter observation again", () => {
  const favoriteOnly = logic.removeObservationFromWatchlist(
    [observedFavorite],
    observedFavorite.code
  );
  const exclusions = logic.upsertObservationExclusion(
    [],
    observedFavorite,
    new Date().toISOString()
  );
  const newEvent = {
    ...observedFavorite,
    favorite: false,
    limitDate: "2026-08-20",
    tradingDaysSince: 1
  };
  const merged = logic.mergeObservationPool(favoriteOnly, [newEvent], exclusions);

  assert.equal(merged[0].favorite, true);
  assert.equal(merged[0].autoAdded, true);
  assert.equal(merged[0].limitDate, "2026-08-20");
});

test("removing a non-favorite observation deletes the record consistently", () => {
  const observation = { ...observedFavorite, favorite: false };
  assert.deepEqual(
    logic.removeObservationFromWatchlist([observation], observation.code),
    []
  );
});
