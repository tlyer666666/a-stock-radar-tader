"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { after, test } = require("node:test");
const React = require("react");
const ts = require("typescript");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const restoreTypeScript = registerTypeScript();
const { normalizeBacktestDraft, normalizeBacktestStrategyProfile } = require("./backtestModel.ts");
const { initialSettings } = require("../../domain/settings.ts");
const { shanghaiDateTag } = require("../../dateUtils.ts");
const stock = { code: "600519", name: "贵州茅台", secid: "1.600519", assetType: "stock" };
const anotherStock = { code: "600036", name: "招商银行", secid: "1.600036", assetType: "stock" };
const noop = () => {};
const deferred = () => { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };

// Execute the real component and its event handlers. Only React's host scheduling and
// the external stock API are replaced, so these cases run without a browser/session.
function mountView({ search = async () => [stock], draft: draftInput = {} } = {}) {
  const state = [];
  const effects = [];
  const refs = [];
  const timers = new Map();
  let stateIndex = 0;
  let effectIndex = 0;
  let refIndex = 0;
  let dirty = true;
  let tree;
  let focused = null;
  const runs = [];
  const comparisons = [];
  const previousWindow = global.window;
  global.window = {
    stockApi: { search, getStrategyDefinitions: async () => [] },
    setTimeout: (callback) => { const id = Symbol(); timers.set(id, callback); return id; },
    clearTimeout: (id) => timers.delete(id)
  };
  const hooks = {
    ...React,
    useId: () => "backtest-fixture",
    useState(initial) {
      const index = stateIndex++;
      if (!(index in state)) state[index] = typeof initial === "function" ? initial() : initial;
      return [state[index], (value) => {
        const next = typeof value === "function" ? value(state[index]) : value;
        if (!Object.is(next, state[index])) { state[index] = next; dirty = true; }
      }];
    },
    useRef(initial) { const index = refIndex++; return refs[index] ||= { current: initial }; },
    useEffect(callback, deps) {
      const index = effectIndex++;
      const previous = effects[index];
      if (!previous || !deps || deps.some((value, i) => !Object.is(value, previous.deps?.[i]))) {
        effects[index] = { callback, deps, cleanup: previous?.cleanup, pending: true };
      }
    }
  };
  const filename = path.resolve(__dirname, "BacktestView.tsx");
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(__dirname);
  loaded.require = (name) => name === "react" ? hooks : module.require(name.startsWith(".") ? path.resolve(__dirname, name) : name);
  loaded._compile(ts.transpileModule(fs.readFileSync(filename, "utf8"), { fileName: filename, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } }).outputText, filename);
  const draft = normalizeBacktestDraft({ securityCode: stock.code, security: stock, startDate: "2020-01-02", strategyContext: { strategyId: "trend", strategyIds: ["trend"], strategyName: "趋势", source: "single_strategy", strategyEngine: "verified-signal-v2", minimumVotes: 1 }, ...draftInput });
  const props = {
    draft, loading: false, error: "", result: null, history: [], profileComparisons: null,
    onDraftChange: (updater) => { props.draft = updater(props.draft); dirty = true; },
    onInvalidateRun: noop, onRun: (next) => runs.push(next), onRunProfileComparisons: (next) => comparisons.push(next),
    onApplyProfileComparison: noop, onLoadHistory: noop, onExportHistory: noop, onExportCurrent: noop,
    onApplyCurrent: noop, onApplyHistory: noop, onClearHistory: noop, onBack: noop, backLabel: "返回", entryContext: { security: stock, sourceLabel: "研究" },
    onTargetChange: noop, currentSettings: initialSettings,
    executionProfile: normalizeBacktestStrategyProfile({}, initialSettings, draft, []), profileDiff: () => [],
    evaluateBacktestExecutionReadiness: () => ({ level: "wait", status: "WAIT", score: 0, recommendation: "等待" }),
    buildBacktestExecutionPlan: () => ({ rationale: [] }), onOpenPortfolio: noop
  };
  function nodes(value, result = []) {
    if (arguments.length === 0) value = tree;
    if (Array.isArray(value)) { value.forEach((child) => nodes(child, result)); return result; }
    if (!value || typeof value !== "object" || !value.props) return result;
    result.push(value);
    nodes(value.props.children, result);
    nodes(value.props.actions, result);
    return result;
  }
  function render() {
    for (let attempt = 0; dirty; attempt++) {
      assert.ok(attempt < 30, "component render must settle");
      dirty = false; stateIndex = 0; effectIndex = 0; refIndex = 0;
      tree = loaded.exports.BacktestView(props);
      for (const node of nodes()) if (node.props.ref && typeof node.props.ref === "object") node.props.ref.current = { focus: () => { focused = node; } };
      for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup?.(); effect.cleanup = effect.callback(); }
    }
  }
  async function flush() { for (let i = 0; i < 8; i++) { render(); await Promise.resolve(); } render(); }
  const find = (predicate) => { const node = nodes().find(predicate); assert.ok(node, "expected element should exist"); return node; };
  const input = (attribute) => find((node) => node.type === "input" && attribute in node.props);
  const button = (label) => find((node) => node.type === "button" && text(node).includes(label));
  function text(value) { if (arguments.length === 0) value = tree; if (Array.isArray(value)) return value.map(text).join(""); if (typeof value === "string" || typeof value === "number") return String(value); return value?.props ? text(value.props.children) + text(value.props.actions) : ""; }
  async function change(attribute, value) { input(attribute).props.onChange({ target: { value } }); await flush(); }
  async function key(key, extras = {}) { input("placeholder").props.onKeyDown({ key, nativeEvent: {}, preventDefault: noop, ...extras }); await flush(); }
  render();
  return {
    props, runs, comparisons, input, button, text, nodes, flush, change, key,
    get focused() { return focused; },
    async searchNow() { for (const [id, callback] of [...timers]) { timers.delete(id); callback(); } await flush(); },
    async run(label = "从所选日期开始回测") { await button(label).props.onClick(); await flush(); },
    dispose() { for (const effect of effects) effect.cleanup?.(); global.window = previousWindow; }
  };
}

for (const runLabel of ["从所选日期开始回测", "运行三档对比"]) {
  test(`${runLabel}: invalid date is preserved, reported and focused before invoking a runner`, async (t) => {
    const view = mountView(); t.after(() => view.dispose()); await view.flush();
    for (const date of ["", "2009-12-31", "2999-01-01", "2024-02-30"]) {
      await view.change("data-backtest-start-date", date);
      await view.run(runLabel);
      const field = view.input("data-backtest-start-date");
      assert.equal(field.props.value, date);
      assert.equal(view.runs.length + view.comparisons.length, 0, "invalid date must never reach normalized runner");
      assert.equal(field.props["aria-invalid"], true);
      assert.equal(view.focused?.props["data-backtest-start-date"], true);
    }
  });

  test(`${runLabel}: invalid custom prices are retained and blocked while blank uses historical open`, async (t) => {
    const view = mountView(); t.after(() => view.dispose()); await view.flush();
    for (const price of ["0", "-1", "000.0001", "1000001", "1e309", "abc", "0x10"]) {
      await view.change("data-backtest-custom-entry-price", price);
      await view.run(runLabel);
      const field = view.input("data-backtest-custom-entry-price");
      assert.equal(String(field.props.value), price);
      assert.equal(field.props["aria-invalid"], true);
      assert.equal(view.focused?.props["data-backtest-custom-entry-price"], true);
      assert.equal(view.runs.length + view.comparisons.length, 0);
    }
    await view.change("data-backtest-start-date", shanghaiDateTag());
    await view.change("data-backtest-custom-entry-price", "");
    await view.run(runLabel);
    assert.equal((view.runs[0] || view.comparisons[0]).customEntryPrice, null);
  });
}

test("search failures remain retryable and never become an empty result or execute a guessed code", async (t) => {
  let fail = true;
  const view = mountView({ search: async () => { if (fail) throw new Error("网络断开"); return [stock]; } });
  t.after(() => view.dispose()); await view.flush();
  await view.change("placeholder", stock.code); await view.searchNow();
  assert.match(view.text(), /搜索失败/);
  assert.doesNotMatch(view.text(), /未找到对应A股/);
  await view.run();
  assert.equal(view.runs.length, 0);
  assert.match(view.text(), /搜索失败/);
  fail = false;
  await view.button("重试搜索").props.onClick(); await view.flush(); await view.searchNow();
  assert.ok(view.nodes().some((node) => node.props.role === "option"));
  assert.doesNotMatch(view.text(), /搜索失败/);
});

test("a successful empty search reports no match and cannot run an unknown six digit code", async (t) => {
  const view = mountView({ search: async () => [] }); t.after(() => view.dispose()); await view.flush();
  await view.change("placeholder", "999999"); await view.searchNow(); await view.run();
  assert.match(view.text(), /未找到对应A股/);
  assert.equal(view.runs.length, 0);
});

test("combobox arrow keys and Enter select the active stock without starting a backtest", async (t) => {
  const view = mountView({ search: async () => [stock, anotherStock] }); t.after(() => view.dispose()); await view.flush();
  await view.change("placeholder", "股票"); await view.searchNow();
  assert.equal(view.input("placeholder").props.role, "combobox");
  assert.equal(view.input("placeholder").props["aria-expanded"], true);
  await view.key("ArrowDown");
  await view.key("ArrowUp");
  await view.key("ArrowUp");
  const activeId = view.input("placeholder").props["aria-activedescendant"];
  assert.equal(view.nodes().find((node) => node.props.id === activeId)?.props["aria-selected"], true);
  await view.key("Enter");
  assert.equal(view.props.draft.securityCode, anotherStock.code);
  assert.equal(view.runs.length, 0);
  assert.equal(view.input("placeholder").props["aria-expanded"], false);
});

test("Escape closes suggestions and IME Enter leaves the input and runner untouched", async (t) => {
  const view = mountView({ search: async () => [stock, anotherStock] }); t.after(() => view.dispose()); await view.flush();
  await view.change("placeholder", "股票"); await view.searchNow();
  view.input("placeholder").props.onCompositionStart(); await view.key("Enter", { nativeEvent: { isComposing: true } });
  assert.equal(view.input("placeholder").props.value, "股票");
  assert.equal(view.runs.length, 0);
  view.input("placeholder").props.onCompositionEnd(); await view.key("Escape");
  assert.equal(view.input("placeholder").props["aria-expanded"], false);
});

test("stale lookup failure does not replace newer successful suggestions", async (t) => {
  const stale = deferred();
  const view = mountView({ search: (keyword) => keyword === "旧股票" ? stale.promise : Promise.resolve([anotherStock]) });
  t.after(() => view.dispose()); await view.flush();
  await view.change("placeholder", "旧股票"); await view.searchNow();
  await view.change("placeholder", "新股票"); await view.searchNow();
  stale.reject(new Error("旧请求网络失败")); await view.flush();
  assert.doesNotMatch(view.text(), /搜索失败/);
  assert.ok(view.nodes().some((node) => node.props.role === "option" && view.text(node).includes(anotherStock.name)));
});

test("date and price boundary values reach the runner without changing their meaning", async (t) => {
  const view = mountView(); t.after(() => view.dispose()); await view.flush();
  await view.change("data-backtest-start-date", "2010-01-01");
  await view.change("data-backtest-custom-entry-price", "0.001");
  await view.run();
  assert.equal(view.runs[0].startDate, "2010-01-01");
  assert.equal(view.runs[0].customEntryPrice, 0.001);
  await view.change("data-backtest-start-date", shanghaiDateTag());
  await view.change("data-backtest-custom-entry-price", "1000000");
  await view.run();
  assert.equal(view.runs[1].customEntryPrice, 1_000_000);
});

test("Escape keeps a pending suggestion response closed when it arrives", async (t) => {
  const pending = deferred();
  const view = mountView({ search: () => pending.promise }); t.after(() => view.dispose()); await view.flush();
  await view.change("placeholder", "股票"); await view.searchNow(); await view.key("Escape");
  pending.resolve([stock, anotherStock]); await view.flush();
  assert.equal(view.input("placeholder").props["aria-expanded"], false);
  assert.equal(view.runs.length, 0);
});

test("editing the stock while resolving an execution request ignores that older response", async (t) => {
  const pending = deferred();
  const view = mountView({ search: () => pending.promise }); t.after(() => view.dispose()); await view.flush();
  await view.change("placeholder", "600519");
  const run = view.button("从所选日期开始回测").props.onClick(); await view.flush();
  await view.change("placeholder", "600036");
  pending.resolve([stock]); await run; await view.flush();
  assert.equal(view.input("placeholder").props.value, "600036");
  assert.equal(view.runs.length, 0);
});

after(() => restoreTypeScript());
