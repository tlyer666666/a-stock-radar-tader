"use strict";
// 实测因子（不过热 / 低位涨停 / 深跌底部）与实测方向快捷组合（2026-11-21）。
const assert = require("node:assert/strict");
const { after, before, test } = require("node:test");
const { registerTypeScript } = require("../qa/register-typescript.cjs");
const rules = require("./strategy-field-rules.cjs");
const intelligence = require("./strategy-intelligence.cjs");
const policy = require("./analysis-selection-policy.cjs");
const conditions = require("../config/strategy-custom-conditions.json");
const signalCatalog = require("../config/strategy-signal-catalog.json");

let settings, presets, restore;
before(() => {
  restore = registerTypeScript();
  settings = require("../src/domain/settings.ts");
  presets = require("../src/quickStrategyPresets.ts");
});
after(() => restore?.());

/** 造一段日线：closes 为收盘序列；每天振幅和量可单独覆盖。 */
function bars(closes, patch = {}) {
  return closes.map((close, index) => {
    const previous = index ? closes[index - 1] : close;
    const row = { date: `d${String(index).padStart(3, "0")}`, open: previous, close, high: Math.max(previous, close) * 1.002, low: Math.min(previous, close) * 0.998, volume: 1000, turnover: 1 };
    return { ...row, ...(patch[index] || {}) };
  });
}
const cents = value => Math.round(value * 100) / 100;
/** 前 60 天横在 20 元，后 60 天跌到 11 元，再来一个 10% 涨停，之后按 tail 走（价格取到分，便于识别涨停）。 */
function fallenThenBoard(tail = []) {
  const decline = [...Array.from({ length: 60 }, () => 20), ...Array.from({ length: 60 }, (_, i) => cents(20 - (9 * (i + 1)) / 60))];
  const board = cents(decline.at(-1) * 1.1);
  return { closes: [...decline, board, ...tail.map(k => cents(board * k))], boardIndex: 120 };
}

test("深跌后的首个涨停：低位涨停与深跌底部成立；涨停当天不因固有的大涨、收盘高位被判过热", () => {
  const { closes, boardIndex } = fallenThenBoard();
  const snapshot = rules.measuredFactorSnapshot({ history: bars(closes), eventIndex: boardIndex, evaluationIndex: boardIndex, limitIndices: [boardIndex], closePosition: 1, volumeRatio: 2.5, heldSupport: true });
  assert.equal(snapshot.lowPositionBoard, true);
  assert.equal(snapshot.deepBase, true);
  assert.equal(snapshot.notOverheated, true);
  assert.deepEqual(snapshot.overheatFlags, []);
  assert.ok(snapshot.limitReturn60Percent < 0 && snapshot.limitMa20ExtensionPercent <= rules.LOW_FIRST_BOARD.maxMa20ExtensionPercent);
  assert.ok(snapshot.ma60GapPercent <= rules.DEEP_BASE.ma60GapPercent);
});

test("涨停后跌破涨停日最低价、连板、或涨停前已经涨过一段，都不算低位涨停", () => {
  const { closes, boardIndex } = fallenThenBoard([0.99, 0.98]);
  const base = { history: bars(closes), eventIndex: boardIndex, evaluationIndex: closes.length - 1, limitIndices: [boardIndex], closePosition: 0.4, volumeRatio: 0.7 };
  assert.equal(rules.measuredFactorSnapshot({ ...base, heldSupport: true }).lowPositionBoard, true);
  assert.equal(rules.measuredFactorSnapshot({ ...base, heldSupport: false }).lowPositionBoard, false, "跌破涨停日最低价");
  assert.equal(rules.measuredFactorSnapshot({ ...base, heldSupport: true, limitIndices: [boardIndex - 1, boardIndex] }).lowPositionBoard, false, "前一日也是涨停，不是首板");

  const rising = Array.from({ length: 120 }, (_, i) => 10 + (6 * i) / 119);
  const risenCloses = [...rising, rising.at(-1) * 1.1];
  const risen = rules.measuredFactorSnapshot({ history: bars(risenCloses), eventIndex: 120, evaluationIndex: 120, limitIndices: [120], closePosition: 1, volumeRatio: 2, heldSupport: true });
  assert.equal(risen.lowPositionBoard, false, "涨停前60日已经上涨");
  assert.equal(risen.deepBase, false);
});

test("不过热：非涨停日满足 2 项及以上过热指标即不成立；历史不足时不当作「不过热」", () => {
  const { closes, boardIndex } = fallenThenBoard([1.06, 1.12]);
  const history = bars(closes);
  const hot = rules.measuredFactorSnapshot({ history, eventIndex: boardIndex, evaluationIndex: closes.length - 1, limitIndices: [boardIndex], closePosition: 0.95, volumeRatio: 1.8, heldSupport: true });
  assert.equal(hot.notOverheated, false);
  assert.ok(hot.overheatFlags.length >= rules.OVERHEAT.vetoAtCount, hot.overheatFlags.join("、"));
  const calm = rules.measuredFactorSnapshot({ history: bars(fallenThenBoard([0.99, 0.985]).closes), eventIndex: boardIndex, evaluationIndex: 122, limitIndices: [boardIndex], closePosition: 0.3, volumeRatio: 0.6, heldSupport: true });
  assert.equal(calm.notOverheated, true);
  const short = rules.measuredFactorSnapshot({ history: bars([10, 10.1, 10.2]), eventIndex: null, evaluationIndex: 2, closePosition: 0.5, volumeRatio: 1, heldSupport: false });
  assert.equal(short.notOverheated, false);
  assert.equal(short.ma20ExtensionPercent, null);
  assert.deepEqual(rules.measuredFactorSnapshot({}), rules.measuredFactorSnapshot({ history: [], evaluationIndex: 0 }), "无效输入返回同一份空结果");
});

test("深跌底部的阈值与策略库「深跌底部首板」一致", () => {
  const strategy = signalCatalog.find(item => item.id === "bottom_deep_first_board");
  assert.equal(strategy.parameters.deepMa60GapPercent, rules.DEEP_BASE.ma60GapPercent);
});

test("历史回放与实时分析用同一口径：三个实测因子进入可回放因子表并能匹配", () => {
  for (const id of ["notOverheated", "lowPositionBoard", "deepBase"]) assert.ok(intelligence.LEGACY_DAILY_FACTORS.includes(id), id);
  const { closes, boardIndex } = fallenThenBoard([0.99, 0.985]);
  // 涨停日要让回放自己的涨停识别认得出来：给足高低开收。
  const history = bars(closes, { [boardIndex]: { open: closes[boardIndex - 1] * 1.02, high: closes[boardIndex], low: closes[boardIndex - 1] * 1.01, volume: 3000 } });
  const snapshot = intelligence.legacyFactorSnapshot(history, closes.length - 1, "600000", "样本");
  assert.equal(snapshot.hasEvent, true, "回放识别到涨停");
  assert.equal(snapshot.factors.lowPositionBoard, true);
  assert.equal(snapshot.factors.deepBase, true);
  assert.equal(snapshot.factors.notOverheated, true);
});

test("设置页、自定义策略词表和主进程策略政策三处的因子与组合保持一致", () => {
  const optionIds = new Set(settings.strategyOptions.map(item => item.id));
  const catalogIds = new Set(conditions.factors.map(item => item.id));
  for (const id of ["notOverheated", "lowPositionBoard", "deepBase"]) {
    assert.ok(optionIds.has(id), `settings ${id}`);
    assert.ok(catalogIds.has(id), `catalog ${id}`);
    assert.equal(settings.strategyOptions.find(item => item.id === id).measured, true);
    assert.equal(conditions.factors.find(item => item.id === id).group, "daily");
  }
  assert.equal(presets.measuredStrategyPresets.length, 5);
  assert.deepEqual(presets.quickStrategyPresets.slice(0, 5).map(item => item.id), presets.measuredStrategyPresets.map(item => item.id), "实测方向的组合排在最前");
  for (const preset of presets.measuredStrategyPresets) {
    assert.equal(preset.measured, true);
    const resolved = policy.presetForSelection(preset.strategies);
    assert.equal(resolved?.id, preset.id, `${preset.id} 的因子集合要能被主进程识别为命名组合`);
    assert.ok(resolved.requiredAll.length >= 2, `${preset.id} 至少两个必要条件`);
    assert.ok(resolved.requiredAll.some(id => ["notOverheated", "lowPositionBoard", "deepBase"].includes(id)), `${preset.id} 的必要条件包含实测因子`);
    for (const id of ["trend", "volatility"]) assert.ok(!preset.strategies.includes(id), `${preset.id} 不应要求实测为负贡献的 ${id}`);
    const normalized = settings.normalizeSettings({ ...settings.initialSettings, selectedStrategies: preset.strategies });
    assert.deepEqual(normalized.selectedStrategies, preset.strategies);
  }
});

test("实时个股分析：三个实测因子出现在策略结果里，并与回放给出同样的结论", () => {
  require("../qa/test-env.cjs");
  const { analyzeHistory, strategyDefinitionsFor } = require("./services.cjs");
  const { closes, boardIndex } = fallenThenBoard([0.99, 0.985]);
  const rows = bars(closes, { [boardIndex]: { open: closes[boardIndex - 1] * 1.02, high: closes[boardIndex], low: closes[boardIndex - 1] * 1.01, volume: 3000 } })
    .map((row, index) => ({ ...row, date: new Date(Date.UTC(2026, 0, 5) + index * 86400000).toISOString().slice(0, 10), amount: row.close * row.volume * 100 }));
  const quote = { name: "样本", latest: rows.at(-1).close };
  const analysis = analyzeHistory({ code: "600000" }, quote, rows, null, null, [], rows);
  assert.equal(analysis.limitEvent?.index, boardIndex);
  const results = strategyDefinitionsFor(analysis, quote);
  const byId = Object.fromEntries(results.map(item => [item.id, item]));
  const replay = intelligence.legacyFactorSnapshot(rows, rows.length - 1, "600000", "样本");
  for (const id of ["notOverheated", "lowPositionBoard", "deepBase"]) {
    assert.ok(byId[id], `缺少 ${id}`);
    assert.equal(byId[id].matched, replay.factors[id], `${id} 实时与回放不一致`);
    assert.equal(byId[id].matched, true, id);
    assert.ok(byId[id].detail && !/NaN|undefined/.test(byId[id].detail), byId[id].detail);
  }
  assert.equal(results.at(-1).id, "riskVeto", "风险否决仍排在最后");
  // 没有实测数据的旧调用方式不会报错，说明文字写明原因而不是显示 0。
  const bare = strategyDefinitionsFor({ limitEvent: null, volumeRatio: 1, closePosition: 0.5, maxDrawdown: 0, preLimitReturn20: 0 }, { latest: 10 });
  assert.match(bare.find(item => item.id === "notOverheated").detail, /无法判断/);
  assert.match(bare.find(item => item.id === "lowPositionBoard").detail, /近60日没有涨停/);
});
