"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { evaluateTrendStock, rankTrendCandidates } = require("./trend-screener-engine.cjs");

function dates(count = 270) {
  const result = [];
  const day = new Date("2025-01-01T00:00:00Z");
  while (result.length < count) {
    if (day.getUTCDay() !== 0 && day.getUTCDay() !== 6) result.push(day.toISOString().slice(0, 10));
    day.setUTCDate(day.getUTCDate() + 1);
  }
  return result;
}

function fixture(code = "600001") {
  const ds = dates();
  const rawRows = ds.map((date, i) => {
    const close = Number((10 + i * 0.02).toFixed(2));
    return { date, open: close - 0.06, high: close + 0.12, low: close - 0.12, close,
      volume: 8_000_000, amount: 240_000_000 };
  });
  rawRows[263] = { ...rawRows[263], close: 15, high: 15.2, low: 14.9 };
  rawRows[264] = { ...rawRows[264], open: 15.9, high: 16.5, low: 15.8, close: 16.5,
    volume: 10_000_000, amount: 300_000_000 };
  for (let i = 265; i <= 268; i++) {
    rawRows[i] = { ...rawRows[i], open: 16, high: 16.3, low: 15.5, close: 16.1,
      volume: 5_000_000, amount: 220_000_000 };
  }
  rawRows[269] = { ...rawRows[269], open: 16.2, high: 16.7, low: 16.1, close: 16.6,
    volume: 8_000_000, amount: 260_000_000 };
  const adjustedRows = rawRows.map((r) => ({ ...r }));
  const benchmarkRows = ds.map((date, i) => {
    const close = 100 + i * 0.05;
    return { date, open: close - 0.02, high: close + 0.1, low: close - 0.1, close,
      volume: 1, amount: 1 };
  });
  return { security: { code, name: "样本股份", secid: `1.${code}`, assetType: "stock" },
    rawRows, adjustedRows, benchmarkRows, asOf: ds.at(-1) };
}

test("candidate uses latest close limit, emits both patterns once and a raw-price plan", () => {
  const got = evaluateTrendStock(fixture());
  assert.equal(got.kind, "candidate");
  assert.deepEqual(got.candidate.patterns, ["A", "B"]);
  assert.equal(got.candidate.stage, "signal");
  assert.equal(got.candidate.daysSinceLimit, 5);
  assert.equal(got.candidate.limitEvidence, "calculated");
  assert.equal(got.candidate.plan.stop, 15.8);
  assert.ok(got.candidate.plan.maxEntry > got.candidate.plan.stop);
  assert.ok(got.candidate.plan.maxEntry <= 16.6 * 1.03);
  assert.ok(got.candidate.metrics.relativeStrength20 > 0);
});

test("official upper limit is distinguished from calculated limit", () => {
  const input = fixture();
  input.rawRows[264].upperLimit = 16.5;
  assert.equal(evaluateTrendStock(input).candidate.limitEvidence, "official");
});

test("price above a standard or official cap is unverified, not a normal limit", () => {
  for (const official of [false, true]) {
    const input = fixture();
    input.rawRows[264].close = 18;
    input.rawRows[264].high = 18;
    if (official) input.rawRows[264].upperLimit = 16.5;
    input.adjustedRows[264] = { ...input.rawRows[264] };
    assert.equal(evaluateTrendStock(input).kind, "unavailable");
  }
});

test("touching the upper limit without closing there is not a limit event", () => {
  const input = fixture();
  input.rawRows[264].high = 16.5;
  input.rawRows[264].close = 16.4;
  input.adjustedRows[264] = { ...input.rawRows[264] };
  assert.equal(evaluateTrendStock(input).kind, "excluded");
});

test("a newer close-limit event resets t0 and its four-day wait", () => {
  const input = fixture();
  input.rawRows[268].upperLimit = 16.1;
  assert.equal(evaluateTrendStock(input).candidate.daysSinceLimit, 1);
  assert.equal(evaluateTrendStock(input).candidate.stage, "watch");
});

test("latest qualifying limit is included at d14 but excluded at d15", () => {
  for (const [eventIndex, expected] of [[255, "candidate"], [254, "excluded"]]) {
    const input = fixture();
    for (let i = eventIndex + 1; i <= 268; i++) {
      input.rawRows[i] = { ...input.rawRows[i], open: 16, high: 16.3, low: 15.5,
        close: 16.1, volume: 5_000_000, amount: 220_000_000 };
      input.adjustedRows[i] = { ...input.rawRows[i] };
    }
    const cap = Math.round(input.rawRows[eventIndex - 1].close * 1.1 * 100) / 100;
    input.rawRows[eventIndex] = { ...input.rawRows[eventIndex], open: 15.8,
      high: cap, low: 15.6, close: cap, volume: 10_000_000, amount: 300_000_000 };
    input.adjustedRows[eventIndex] = { ...input.rawRows[eventIndex] };
    assert.equal(evaluateTrendStock(input).kind, expected);
  }
});

test("a no-price-limit day is not counted as an ordinary limit", () => {
  const input = fixture();
  input.rawRows[264].noPriceLimit = true;
  assert.equal(evaluateTrendStock(input).kind, "excluded");
});

test("A pullback requires all three prior bars, while B can still signal", () => {
  const input = fixture();
  for (let i = 266; i <= 268; i++) {
    input.rawRows[i].volume = 7_500_000;
    input.adjustedRows[i].volume = 7_500_000;
  }
  input.rawRows[269].volume = 10_000_000;
  input.adjustedRows[269].volume = 10_000_000;
  assert.deepEqual(evaluateTrendStock(input).candidate.patterns, ["B"]);
});

test("current-day data are anchored to asOf; future bars cannot create a signal", () => {
  const input = fixture();
  input.asOf = input.rawRows[268].date;
  assert.equal(evaluateTrendStock(input).candidate.stage, "watch");
});

test("a stock K-line omitted inside the recent limit window is unavailable", () => {
  const input = fixture();
  input.rawRows.splice(266, 1);
  input.adjustedRows.splice(266, 1);
  assert.equal(evaluateTrendStock(input).kind, "unavailable");
});

test("a stock K-line omitted around the thirtieth exchange session is unavailable", () => {
  const input = fixture();
  input.rawRows.splice(240, 1);
  input.adjustedRows.splice(240, 1);
  assert.equal(evaluateTrendStock(input).kind, "unavailable");
});

test("ST, B shares and non-stock assets are excluded", () => {
  for (const security of [
    { ...fixture().security, name: "*ST样本" },
    fixture("900001").security,
    { ...fixture().security, assetType: "index" }
  ]) {
    assert.equal(evaluateTrendStock({ ...fixture(), security }).kind, "excluded");
  }
  for (const [code, board] of [["920001", "beijing"], ["300001", "growth"], ["688001", "star"]]) {
    const input = fixture(code);
    input.rawRows[264].upperLimit = 16.5;
    assert.equal(evaluateTrendStock(input).candidate.board, board);
  }
});

test("explicit current or event-day ST flags veto a candidate", () => {
  const current = fixture(); current.security.isST = true;
  const event = fixture(); event.rawRows[264].isST = true;
  assert.equal(evaluateTrendStock(current).kind, "excluded");
  assert.equal(evaluateTrendStock(event).kind, "excluded");
});

test("zero current volume or amount is unavailable, not a watch result", () => {
  for (const field of ["volume", "amount"]) {
    const input = fixture();
    input.rawRows.at(-1)[field] = 0;
    assert.equal(evaluateTrendStock(input).kind, "unavailable");
  }
});

test("a zero-volume limit event cannot establish a tradable t0", () => {
  const input = fixture();
  input.rawRows[264].volume = 0;
  input.rawRows[264].amount = 0;
  assert.equal(evaluateTrendStock(input).kind, "unavailable");
});

test("missing, malformed, stale, and short histories are unavailable", () => {
  const valid = fixture();
  const malformed = fixture(); malformed.rawRows[100].amount = NaN;
  const stale = fixture(); stale.asOf = "2026-12-31";
  const short = fixture(); short.rawRows = short.rawRows.slice(-249); short.adjustedRows = short.adjustedRows.slice(-249);
  const missing = fixture(); missing.adjustedRows = [];
  for (const input of [malformed, stale, short, missing]) {
    assert.equal(evaluateTrendStock(input).kind, "unavailable");
  }
  assert.equal(evaluateTrendStock(valid).kind, "candidate");
});

test("a row without a date is a malformed history, not silently dropped", () => {
  const input = fixture();
  delete input.rawRows[100].date;
  delete input.adjustedRows[100].date;
  assert.equal(evaluateTrendStock(input).kind, "unavailable");
});

test("recent adjusted/raw factor change with raw volume is unavailable", () => {
  const input = fixture();
  for (let i = 250; i < 265; i++) {
    for (const key of ["open", "high", "low", "close"]) input.adjustedRows[i][key] *= 0.95;
  }
  assert.equal(evaluateTrendStock(input).kind, "unavailable");
});

test("a flat adjustment factor normalizes support and plan to actual quotes", () => {
  const input = fixture();
  for (const row of input.adjustedRows) {
    for (const key of ["open", "high", "low", "close"]) row[key] /= 2;
  }
  const got = evaluateTrendStock(input);
  assert.equal(got.kind, "candidate");
  assert.equal(got.candidate.plan.stop, 15.8);
});

test("stop rounds up to a tradable cent and reported risk remains at most 8 percent", () => {
  const input = fixture();
  input.rawRows[264].low = 15.801;
  input.adjustedRows[264].low = 15.801;
  const plan = evaluateTrendStock(input).candidate.plan;
  assert.equal(plan.stop, 15.81);
  assert.ok((plan.maxEntry - plan.stop) / plan.maxEntry * 100 <= 8.000001);
  assert.equal(plan.maxRiskPercent, Number(((plan.maxEntry - plan.stop) / plan.maxEntry * 100).toFixed(2)));
});

test("unknown benchmark gate cannot be reported passed or give an entry plan", () => {
  const input = fixture(); input.benchmarkRows = [];
  const candidate = evaluateTrendStock(input).candidate;
  assert.equal(candidate.stage, "watch");
  assert.equal(candidate.plan, null);
  assert.equal(candidate.metrics.relativeStrength20, null);
  assert.equal(candidate.evidence.find((row) => row.label === "市场门槛").passed, false);
});

test("benchmark below MA60 pauses an otherwise valid signal", () => {
  const input = fixture();
  for (let i = input.benchmarkRows.length - 60; i < input.benchmarkRows.length; i++) {
    const close = 120 - (i - (input.benchmarkRows.length - 60)) * 0.2;
    input.benchmarkRows[i] = { ...input.benchmarkRows[i], open: close - 0.02,
      high: close + 0.1, low: close - 0.1, close };
  }
  const candidate = evaluateTrendStock(input).candidate;
  assert.equal(candidate.stage, "watch");
  assert.equal(candidate.plan, null);
  assert.ok(candidate.warnings.some((warning) => warning.includes("暂停新开仓")));
});

test("inconsistent official change percentage cannot establish a calculated limit", () => {
  const input = fixture();
  input.rawRows[264].changePct = 2;
  assert.equal(evaluateTrendStock(input).kind, "unavailable");
});

test("benchmark with a missing recent exchange date makes timing unavailable", () => {
  const input = fixture();
  input.benchmarkRows = input.benchmarkRows.filter((r) => r.date !== input.rawRows[249].date);
  assert.equal(evaluateTrendStock(input).kind, "unavailable");
});

test("a partial benchmark calendar cannot verify the full timing window", () => {
  const input = fixture();
  input.benchmarkRows = input.benchmarkRows.slice(-64);
  assert.equal(evaluateTrendStock(input).kind, "unavailable");
});

test("amount is yuan and 20-day mean below 200 million excludes", () => {
  const input = fixture();
  for (let i = 250; i < 270; i++) {
    input.rawRows[i].amount = 150_000_000;
    input.adjustedRows[i].amount = 150_000_000;
  }
  assert.equal(evaluateTrendStock(input).kind, "excluded");
});

test("sorting puts known relative strength first, then amount and code", () => {
  const mk = (code, relativeStrength20, avgAmount20) => ({
    security: { code }, metrics: { relativeStrength20, avgAmount20 }
  });
  const sorted = rankTrendCandidates([
    mk("600003", null, 9), mk("600002", 3, 4), mk("600001", 3, 4), mk("600004", 5, 2)
  ]);
  assert.deepEqual(sorted.map((row) => row.security.code), ["600004", "600001", "600002", "600003"]);
});

test("302 ChiNext securities use the same 20-percent board rule as 300 and 301", () => {
  const input=fixture("302132");input.security.secid="0.302132";
  input.rawRows[264].upperLimit=16.5;
  assert.equal(evaluateTrendStock(input).candidate.board,"growth");
  delete input.rawRows[264].upperLimit;
  assert.equal(evaluateTrendStock(input).kind,"excluded","10-percent move is not a 302 limit");
  input.rawRows[264]={...input.rawRows[264],close:18,high:18};
  input.adjustedRows[264]={...input.rawRows[264]};
  assert.equal(evaluateTrendStock(input).kind,"candidate","20-percent move is a 302 limit");
});
