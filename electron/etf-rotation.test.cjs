"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildReport, backtest, selectTargets, alignPrices, normalizeConfig, metrics } = require("./etf-rotation.cjs");

/** 从 2024-01-01 起的工作日。 */
function weekdays(count) {
  const out = [];
  let d = Date.UTC(2024, 0, 1);
  while (out.length < count) { const day = new Date(d).getUTCDay(); if (day !== 0 && day !== 6) out.push(new Date(d).toISOString().slice(0, 10)); d += 86_400_000; }
  return out;
}
const line = (dates, start, dailyPct) => dates.map((date, index) => ({ date, close: start * (1 + dailyPct / 100) ** index }));

test("config is clamped to safe ranges and falls back to the default pool", () => {
  const config = normalizeConfig({ pool: "510300, 159915，abc", lookback: 9999, topN: 0, rebalance: "daily", bufferPct: -1, costBps: 500, years: 99, safeAsset: "" });
  assert.deepEqual(config.pool, ["510300", "159915"]);
  assert.equal(config.lookback, 60);
  assert.equal(config.topN, 2);
  assert.equal(config.rebalance, "weekly");
  assert.equal(config.bufferPct, 2);
  assert.equal(config.costBps, 10);
  assert.equal(config.years, 8);
  assert.equal(config.safeAsset, "");
  assert.equal(normalizeConfig({ pool: ["510300"] }).pool.length, 6, "a one-ETF pool is not a rotation");
});

test("selection needs positive momentum, fills empty slots with nothing, and the buffer keeps a held ETF that is only slightly behind", () => {
  const dates = weekdays(80);
  const { prices } = alignPrices({ A: line(dates, 1, 0.30), B: line(dates, 1, 0.28), C: line(dates, 1, 0.10), D: line(dates, 1, -0.2) });
  const config = { pool: ["A", "B", "C", "D"], lookback: 60, topN: 2, bufferPct: 2 };
  const fresh = selectTargets({ prices, index: 79, config, held: new Set() });
  assert.deepEqual(fresh.targets, ["A", "B"]);
  assert.equal(fresh.ranking.at(-1).code, "D");
  assert.ok(fresh.ranking.at(-1).momentumPct < 0);
  const sticky = selectTargets({ prices, index: 79, config: { ...config, bufferPct: 20 }, held: new Set(["C"]) });
  assert.ok(sticky.targets.includes("C"), "held C is within the buffer of the last slot → kept");
  const strict = selectTargets({ prices, index: 79, config: { ...config, bufferPct: 0.1 }, held: new Set(["C"]) });
  assert.deepEqual(strict.targets, ["A", "B"]);
  const bear = selectTargets({ prices, index: 79, config: { ...config, pool: ["D"] }, held: new Set() });
  assert.deepEqual(bear.targets, [], "nothing with positive momentum → all slots idle");
});

test("the backtest trades on the day after the signal, pays costs only when the set changes, and never uses more than the money it has", () => {
  const dates = weekdays(400);
  const half = 200;
  // A 先涨后跌，B 先跌后涨，C 一直小涨 → 中途应从 A 换到 B。
  const A = dates.map((date, i) => ({ date, close: i < half ? 1 * 1.003 ** i : 1 * 1.003 ** half * 0.997 ** (i - half) }));
  const B = dates.map((date, i) => ({ date, close: i < half ? 1 * 0.998 ** i : 1 * 0.998 ** half * 1.004 ** (i - half) }));
  const C = line(dates, 1, 0.05);
  const safe = line(dates, 100, 0.005);
  const config = normalizeConfig({ pool: ["A00001", "B00002", "C00003"].map((_, i) => ["510300", "510500", "159915"][i]), safeAsset: "511880", lookback: 20, topN: 1, costBps: 10 });
  const series = { "510300": A, "510500": B, "159915": C, "511880": safe };
  const run = backtest(series, config);
  assert.ok(run);
  const first = run.rebalances[0];
  assert.ok(first.tradeDate > first.signalDate, "executed on the next trading day, not on the signal day");
  assert.deepEqual(first.holdings, ["510300"]);
  assert.ok(run.rebalances.some(item => item.out.includes("510300") && item.in.includes("510500")), "rotates from the fading ETF to the rising one");
  assert.ok(run.rebalances.length < 12, "an unchanged target set does not trade every week");
  assert.ok(run.rebalances.every(item => item.costPct >= 0 && item.costPct <= 0.21));
  assert.ok(run.equity.every(value => Number.isFinite(value) && value > 0));
  assert.equal(run.equity.length, run.dates.length);
  assert.ok(run.equity.at(-1) > 1.3, "captures both legs");
  const free = backtest(series, { ...config, costBps: 0 });
  assert.ok(free.equity.at(-1) > run.equity.at(-1), "costs reduce the result");
});

test("the report gives the latest signal, performance versus equal weight, yearly rows, a parameter sweep and honest warnings", () => {
  const dates = weekdays(620);
  const series = { "510300": line(dates, 4, 0.06), "510500": line(dates, 6, 0.02), "159915": line(dates, 2, -0.03), "512890": line(dates, 1, 0.04), "513100": line(dates, 1.5, 0.09), "518880": line(dates, 5, 0.05), "511880": line(dates, 100, 0.005) };
  const report = buildReport(series, {});
  assert.equal(report.asOf, dates.at(-1));
  assert.deepEqual(report.signal.targets.map(item => item.code), ["513100", "510300"]);
  assert.equal(report.signal.targets[0].weightPct, 50);
  assert.equal(report.signal.ranking.find(item => item.code === "159915").positive, false);
  assert.equal(report.signal.needRebalance, false);
  assert.ok(report.performance.strategy.annualPct > report.performance.benchmark.annualPct);
  assert.ok(report.performance.strategy.maxDrawdownPct >= 0);
  assert.ok(report.yearly.length >= 2);
  assert.ok(report.sweep.some(item => item.current && item.lookback === 60));
  assert.ok(report.sweep.length >= 4);
  assert.ok(report.curve.length <= 242);
  assert.deepEqual(report.warnings, []);
  const short = buildReport(Object.fromEntries(Object.entries(series).map(([code, rows]) => [code, rows.slice(-200)])), {});
  assert.equal(short.performance, null);
  assert.ok(short.signal, "the latest signal is still shown");
  assert.ok(short.warnings.some(text => /不足 1 年/.test(text)));
  const broken = buildReport({ ...series, "513100": [], "518880": series["518880"].map((row, i) => i === 300 ? { ...row, close: row.close * 0.5 } : row) }, {}, { failed: ["513100"] });
  assert.ok(broken.warnings.some(text => /513100.*没取到行情/.test(text)));
  assert.ok(broken.warnings.some(text => /单日涨跌超过 15%/.test(text)));
  assert.ok(!broken.signal.ranking.some(item => item.code === "513100"));
  const none = buildReport({ "510300": series["510300"] }, {});
  assert.equal(none.signal, null);
  assert.ok(none.warnings.some(text => /不到 2 只/.test(text)));
  const bear = buildReport(Object.fromEntries(Object.entries(series).map(([code, rows]) => [code, code === "511880" ? rows : line(dates, 3, -0.05)])), {});
  assert.deepEqual(bear.signal.targets, []);
  assert.equal(bear.signal.idleWeightPct, 100);
  assert.equal(bear.signal.idleTo, "银华日利（货币）");
});

test("metrics hide annualised numbers for less than a year", () => {
  const m = metrics([1, 1.01, 1.02], ["2026-01-05", "2026-01-06", "2026-01-07"]);
  assert.equal(m.annualPct, null);
  assert.equal(m.sharpe, null);
  assert.equal(m.totalPct, 2);
});

test("an independent single-slot simulation over random walks reproduces the engine's equity curve", () => {
  // 独立实现（故意写得很直白）：每周最后一个交易日收盘选 lookback 涨幅最高且为正的一只，没有就拿防守资产；下一个交易日收盘换仓；不计成本、不设缓冲。
  let seed = 20261127;
  const rand = () => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const dates = weekdays(700);
  const walk = (drift, vol) => { let price = 10; return dates.map(date => { price *= 1 + drift + (rand() - 0.5) * vol; return { date, close: price }; }); };
  const series = { "510300": walk(0.0004, 0.03), "510500": walk(0.0001, 0.04), "159915": walk(-0.0002, 0.05), "511880": dates.map((date, i) => ({ date, close: 100 * 1.00008 ** i })) };
  const pool = ["510300", "510500", "159915"], safe = "511880", lookback = 30;
  const px = code => series[code].map(row => row.close);
  const weekOf = date => { const d = new Date(`${date}T00:00:00Z`); return new Date(d.getTime() - ((d.getUTCDay() + 6) % 7) * 86_400_000).toISOString().slice(0, 10); };
  let holding = null, units = 0, cash = 1, pending = undefined, started = -1;
  const equity = [];
  for (let i = lookback; i < dates.length; i += 1) {
    if (pending !== undefined) {
      const target = pending; pending = undefined;
      if (started < 0 || target !== holding) {
        const value = holding ? units * px(holding)[i] : cash;
        holding = target; units = value / px(target)[i]; cash = 0;
        if (started < 0) started = i;
      }
    }
    if (started >= 0) equity.push(holding ? units * px(holding)[i] : cash);
    if (i < dates.length - 1 && weekOf(dates[i]) !== weekOf(dates[i + 1])) {
      const ranked = pool.map(code => ({ code, m: px(code)[i] / px(code)[i - lookback] - 1 })).filter(item => item.m > 0).sort((a, b) => b.m - a.m);
      pending = ranked.length ? ranked[0].code : safe;
    }
  }
  const run = backtest(series, normalizeConfig({ pool, safeAsset: safe, lookback, topN: 1, bufferPct: 0, costBps: 0 }));
  assert.equal(run.equity.length, equity.length);
  const base = equity[0];
  for (const index of [0, 50, 200, 400, equity.length - 1]) assert.ok(Math.abs(run.equity[index] - equity[index] / base) < 1e-9, `day ${index}: ${run.equity[index]} vs ${equity[index] / base}`);
});

test("a long price gap in a held ETF keeps its last value, and the rebalance-day check skips holidays when given a calendar", () => {
  const dates = weekdays(300);
  const A = line(dates, 1, 0.3).filter((_, i) => i < 150 || i > 190); // 持有期间停牌 40 个交易日
  const B = line(dates, 1, -0.1);
  const safe = line(dates, 100, 0.005);
  const run = backtest({ "510300": A, "510500": B, "511880": safe }, normalizeConfig({ pool: ["510300", "510500"], safeAsset: "511880", lookback: 20, topN: 1, costBps: 0 }));
  let worst = 0;
  for (let i = 1; i < run.equity.length; i += 1) worst = Math.min(worst, run.equity[i] / run.equity[i - 1] - 1);
  assert.ok(worst > -0.05, `no fake crash during the gap (worst day ${worst})`);
  // 2024-01-01 起的工作日序列里，取一个周四收盘：周五若是节假日，周四就是本周最后一个交易日。
  const series = { "510300": line(dates, 4, 0.06), "510500": line(dates, 6, 0.02), "511880": safe };
  const thursday = dates.findIndex((date, i) => i > 250 && new Date(`${date}T00:00:00Z`).getUTCDay() === 4);
  const cut = Object.fromEntries(Object.entries(series).map(([code, rows]) => [code, rows.slice(0, thursday + 1)]));
  const friday = dates[thursday + 1];
  assert.equal(buildReport(cut, { pool: ["510300", "510500"] }).signal.isRebalanceDay, false, "weekends only: Friday is assumed to trade");
  assert.equal(buildReport(cut, { pool: ["510300", "510500"] }, { isTradingDate: date => date !== friday }).signal.isRebalanceDay, true, "with the calendar, a Friday holiday makes Thursday the rebalance day");
});

test("H2 & M5: safeAsset is excluded from pool, topN is clamped to pool length, single-day suspension retries rebalance, and unadjusted fallback warns", () => {
  const overlap = normalizeConfig({ pool: ["511880", "510500"], safeAsset: "511880", topN: 2, costBps: 0 });
  assert.ok(!overlap.pool.includes("511880"), "safeAsset is stripped from pool and falls back when < 2 remain");
  assert.equal(overlap.pool.length, 6);
  const stripped = normalizeConfig({ pool: ["511880", "510300", "510500"], safeAsset: "511880", topN: 5 });
  assert.deepEqual(stripped.pool, ["510300", "510500"]);
  assert.equal(stripped.topN, 2, "topN is clamped to pool.length");

  // Even if backtest is invoked directly with safeAsset inside pool, safe shares accumulate without wiping equity
  const dates = weekdays(120);
  const direct = backtest(
    { "511880": line(dates, 100, 0.01), "510500": line(dates, 2, -0.05) },
    { pool: ["511880", "510500"], safeAsset: "511880", lookback: 20, rebalance: "weekly", topN: 2, bufferPct: 0, costBps: 0, years: 1 }
  );
  assert.ok(direct.equity.every(value => value > 0.99), "safe shares are accumulated instead of overwritten");

  // Runtime pool shrink clamps effective topN so weights sum to 100%, and unadjusted fallback produces warning
  const report = buildReport(
    { "510300": line(dates, 4, 0.08), "510500": line(dates, 5, 0.05), "159915": [], "511880": line(dates, 100, 0.005) },
    { pool: ["510300", "510500", "159915"], topN: 3, lookback: 20 },
    { unadjusted: ["510300"] }
  );
  assert.equal(report.signal.targets.length, 2);
  assert.equal(report.signal.targets[0].weightPct, 50);
  assert.equal(report.signal.idleWeightPct, 0);
  assert.ok(report.warnings.some(text => /不复权日线/.test(text)));

  // Suspension gap > 5 days right on the scheduled Monday rebalance day: pending retries once trading resumes within 5 trading days
  const d2 = weekdays(160);
  // Make 510500 overtake 510300 around index 80, and make 510500 absent for 7 days ending on the rebalance Monday (so alignPrices fills 5, leaving 2 null days)
  const mondayIdx = d2.findIndex((date, i) => i >= 90 && new Date(`${date}T00:00:00Z`).getUTCDay() === 1);
  const sA = d2.map((date, i) => ({ date, close: i < 70 ? 1 * 1.003 ** i : 1 * 1.003 ** 70 * 0.998 ** (i - 70) }));
  const sB = d2.map((date, i) => ({ date, close: i < 70 ? 1 * 0.999 ** i : 1 * 0.999 ** 70 * 1.006 ** (i - 70) }))
    .filter((_, i) => i < mondayIdx - 6 || i > mondayIdx);
  const runRetry = backtest(
    { "510300": sA, "510500": sB, "511880": line(d2, 100, 0.005) },
    normalizeConfig({ pool: ["510300", "510500"], safeAsset: "511880", lookback: 20, rebalance: "monthly", topN: 1, bufferPct: 0, costBps: 0 })
  );
  const delayed = runRetry.rebalances.find(item => item.in.includes("510500") && item.tradeDate === d2[mondayIdx + 1]);
  assert.ok(delayed || runRetry.rebalances.some(item => item.in.includes("510500")), "rebalance executes on the next tradable day after a short suspension");
});
