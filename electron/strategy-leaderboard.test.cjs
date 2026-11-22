"use strict";
// 策略实测榜：回放 → 合并 → 汇总 → 服务编排（2026-11-21）。
const test = require("node:test");
const assert = require("node:assert/strict");
const engine = require("./strategy-signal-engine.cjs");
const lb = require("./strategy-leaderboard.cjs");
const { createStrategyLeaderboardService } = require("./strategy-leaderboard-service.cjs");
const { createDailyBarStore } = require("./daily-bar-store.cjs");
const { createTradingCalendar } = require("./trend-trading-calendar.cjs");

const calendar = createTradingCalendar();
const cents = value => Math.round(value * 100) / 100;

/** 造全市场日线：每只跌两年再给一个 10% 首板，之后横盘。确保每只股票都有有效信号样本。 */
function universe(count, days = 430, seedStart = 7) {
  let seed = seedStart;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const dates = [];
  for (let current = calendar.previousSession("2026-10-20", true); current && dates.length < days; current = calendar.previousSession(current)) dates.unshift(current);
  assert.equal(dates.length, days, "交易日历应覆盖测试需要的日线长度");
  const candidates = [];
  const histories = {};
  for (let s = 0; s < count; s += 1) {
    const code = String(600200 + s);
    const rows = [];
    const base = 20 + rnd() * 4;
    const boardIndex = dates.length - 60 - (s % 12);
    for (let i = 0; i < dates.length; i += 1) {
      const date = dates[i];
      let close;
      if (i === boardIndex) close = cents(rows[i - 1].close * 1.1);
      else if (i < boardIndex) close = cents(base * Math.pow(0.55, i / boardIndex) * (1 + (rnd() - 0.5) * 0.02));
      else close = cents(rows[i - 1].close * (1 + (rnd() - 0.5) * 0.03));
      const open = cents(i ? rows[i - 1].close * (1 + (rnd() - 0.5) * 0.01) : close);
      rows.push({
        date, open, close,
        high: i === boardIndex ? close : cents(Math.max(open, close) * (1 + rnd() * 0.02)),
        low: i === boardIndex ? open : cents(Math.min(open, close) * (1 - rnd() * 0.02)),
        volume: 1e6 * (i === boardIndex ? 4 : 0.5 + rnd()),
        amount: 1e8 * (1 + rnd())
      });
    }
    candidates.push({ code, name: `样本${s}` });
    histories[code] = rows;
  }
  let level = 3000;
  const benchmark = dates.map(date => {
    const open = level;
    level *= 1 + (rnd() - 0.5) * 0.008;
    return { date, open, high: Math.max(open, level) * 1.002, low: Math.min(open, level) * 0.998, close: level, volume: 1e9, amount: 1e12 };
  });
  return { candidates, histories, benchmark };
}

const u = universe(90);

test("一批回放：全部持有期与全部在用策略在同一次特征扫描内算完，样本紧凑可合并", () => {
  const chunk = engine.buildStrategyLeaderboardChunk(u.candidates.slice(0, 45), u.histories, u.benchmark, { signalTo: "2026-10-20" });
  assert.equal(chunk.v, 1);
  assert.equal(chunk.stockCount, 45);
  assert.equal(chunk.definitions.length, engine.STRATEGY_DEFINITIONS.length);
  assert.deepEqual(Object.keys(chunk.horizons).sort((a, b) => Number(a) - Number(b)), ["5", "10", "20"]);
  const horizon5 = chunk.horizons["5"];
  assert.ok(horizon5.baseline.length > 0, "基线有样本");
  const withSamples = Object.values(horizon5.strategies).filter(entry => entry.samples.length);
  assert.ok(withSamples.length >= 4, `至少几套策略有样本，实际 ${withSamples.length}`);
  for (const entry of Object.values(horizon5.strategies)) {
    for (const sample of entry.samples) {
      assert.equal(sample.length, 3, "紧凑样本 [信号日, 净收益, 相对指数]");
      assert.match(sample[0], /^\d{4}-\d{2}-\d{2}$/);
      assert.ok(Number.isFinite(sample[1]));
    }
  }
  assert.throws(() => engine.buildStrategyLeaderboardChunk([], {}, [], {}), /截止交易日/);
});

test("按批拆分再合并，结果与一次算完一致", () => {
  const all = engine.buildStrategyLeaderboardChunk(u.candidates, u.histories, u.benchmark, { signalTo: "2026-10-20" });
  const parts = [
    engine.buildStrategyLeaderboardChunk(u.candidates.slice(0, 30), u.histories, u.benchmark, { signalTo: "2026-10-20" }),
    engine.buildStrategyLeaderboardChunk(u.candidates.slice(30), u.histories, u.benchmark, { signalTo: "2026-10-20" })
  ];
  const merged = lb.mergeLeaderboardChunks(parts);
  const single = lb.mergeLeaderboardChunks([all]);
  for (const horizon of ["5", "10", "20"]) {
    assert.deepEqual(merged.horizons[horizon].baseline, single.horizons[horizon].baseline);
    for (const [id, entry] of Object.entries(single.horizons[horizon].strategies)) {
      assert.deepEqual(merged.horizons[horizon].strategies[id].samples, entry.samples, `${horizon} ${id}`);
    }
  }
});

test("优势按信号日等权：某天成批出信号不会主导结论", () => {
  const strategyDaily = new Map([["d1", 10], ["d2", 0]]);
  const baselineDaily = new Map([["d1", 4], ["d2", 0]]);
  // d1 策略 100 笔平均 +10，d2 策略 1 笔 0；基线 d1 +4、d2 0。
  // 按笔数平均：+2.4；按信号日等权：(+6 + 0) / 2 = +3。
  const weighted = lb.dayWeightedEdge(strategyDaily, baselineDaily);
  assert.equal(weighted.edge, 3);
  assert.equal(weighted.days, 2);
  const stats = lb.basicStats([["d1", 4], ["d1", 6], ["d2", -1]]);
  assert.equal(stats.sampleCount, 3);
  assert.equal(stats.independentSignalDays, 2);
  assert.equal(stats.winRate, 66.7);
  assert.ok(Array.isArray(stats.winRateInterval95));
});

test("汇总：排行榜有方法、基线、各持有期、前后两段和结论；样本不足标记为观察", () => {
  const report = lb.summarizeStrategyLeaderboard([
    engine.buildStrategyLeaderboardChunk(u.candidates, u.histories, u.benchmark, { signalTo: "2026-10-20" })
  ]);
  assert.match(report.method, /次日开盘买入/);
  assert.match(report.edgeDefinition, /信号日/);
  assert.ok(report.window.from && report.window.to && report.splitDate);
  assert.ok(report.baseline["5"].sampleCount > 0);
  const ranked = report.strategies.filter(row => row.horizons["5"].sampleCount > 0);
  assert.ok(ranked.length >= 3);
  assert.equal(ranked[0].rank, 1);
  assert.ok(ranked[0].horizons["5"].winRate >= 0 && ranked[0].horizons["5"].winRate <= 100);
  assert.equal(ranked[0].halves.length, 2);
  const insufficient = report.strategies.filter(row => row.verdict.level === "insufficient");
  assert.ok(insufficient.length > 0, "样本太少的策略只标观察");
  assert.ok(insufficient.every(row => row.verdict.text.includes("样本不足")));
});

function fakeService(universeResult, overrides = {}) {
  const calls = { runChunk: [] };
  const service = createStrategyLeaderboardService({
    listCodes: async () => universeResult.histories ? Object.keys(universeResult.histories) : [],
    readRows: async code => ({ rows: universeResult.histories[code] }),
    loadNames: async () => overrides.names instanceof Error ? Promise.reject(overrides.names) : (overrides.names || new Map()),
    loadBenchmark: async () => universeResult.benchmark,
    runChunk: async (candidates, histories, benchmark, replay) => {
      calls.runChunk.push(candidates.map(item => item.code));
      assert.equal(replay.leaderboard, true);
      return engine.buildStrategyLeaderboardChunk(candidates, histories, benchmark, { signalTo: replay.signalTo });
    },
    resolveSignalTo: () => "2026-10-20",
    isEligibleCode: code => /^60\d{4}$/.test(code),
    isRiskName: name => /ST/.test(name),
    assertActive: () => {},
    minStocks: overrides.minStocks ?? 50
  });
  return { service, calls };
}

test("服务：只读本机日线，按代码排序分批回放，进度与汇总正确", async () => {
  const names = new Map(Object.keys(u.histories).map((code, index) => [code, index === 0 ? "样本ST" : `样本${index}`]));
  const { service, calls } = fakeService(u, { names, minStocks: 80 });
  const report = await service.load();
  assert.equal(report.universe.localStocks, 90);
  assert.equal(report.universe.excludedRisk, 1, "ST 名称被剔除");
  assert.equal(report.universe.replayed, 89);
  assert.deepEqual(calls.runChunk.map(chunk => chunk.length), [89], "本批测试只用一个批次（剔除 ST 后），服务仍按 chunkSize 上限执行");
  const chunkCodes = calls.runChunk[0];
  assert.deepEqual(chunkCodes, Object.keys(u.histories).filter(code => code !== String(600200)).sort(), "ST 被剔除、按代码排序");
  assert.equal(report.stockCount, 89);
  assert.ok(report.strategies.length === engine.STRATEGY_DEFINITIONS.length);
  assert.equal(service.getProgress().active, false, "结束后进度复位");
  assert.ok(report.window.from);
});

test("服务：日线库太小直接报错并提示先选股，不做半吊子的统计", async () => {
  const { service } = fakeService({ candidates: [], histories: {}, benchmark: u.benchmark }, { minStocks: 200 });
  await assert.rejects(() => service.load(), /重新选股|重新选股以补齐|本机日线库只有/);
});

test("本机日线库只读入口：listLocalCodes 只列 6 位 json，readLocal 读已存日线且不写文件", async () => {
  const fs = require("node:fs");
  const os = require("node:os");
  const path = require("node:path");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "daily-bars-"));
  const store = createDailyBarStore({ directory: dir, previousSession: () => "2026-10-19" });
  try {
    fs.writeFileSync(path.join(dir, "600001.json"), JSON.stringify({ version: 1, rows: [["2026-10-20", 10, 11, 9.5, 10.5, 1000, 1e8, null, null, null, null, null, null, null, null, null, null, null, null, null]], source: "test" }));
    fs.writeFileSync(path.join(dir, "selection-report.json"), "{}");
    fs.writeFileSync(path.join(dir, "notacode.json"), "{}");
    assert.deepEqual(await store.listLocalCodes(), ["600001"]);
    const entry = await store.readLocal("600001");
    assert.equal(entry.rows.length, 1);
    assert.equal(entry.lastDate, "2026-10-20");
    assert.equal(await store.readLocal("600999"), null);
    assert.equal(await store.readLocal("../escape"), null);
    assert.equal(fs.readdirSync(dir).filter(name => name.endsWith(".tmp")).length, 0, "只读不产生临时文件");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
