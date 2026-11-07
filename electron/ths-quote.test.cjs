"use strict";
// 同花顺官方免费行情网关的解析契约。
// 这些字段编号是同花顺内部约定，写错不会报错、只会静默给出错误数值
// （曾经把 199112 涨跌幅 与 264648 涨跌额 搞反，导致 +1.55% 被读成 -89.92）。
const test = require("node:test");
const assert = require("node:assert/strict");
const {
  unwrapJsonp, normalizeRealhead, parseThsSectorMembers
} = require("./ths-quote.cjs");

test("JSONP 解包：剥掉 quotebridge_ 包裹", () => {
  const got = unwrapJsonp('quotebridge_v6_realhead_48_881121_defer_last({"items":{"10":"1.23"}})');
  assert.deepEqual(got, { items: { 10: "1.23" } });
  assert.throws(() => unwrapJsonp("not jsonp"), /JSONP/);
});

test("realhead 字段映射：涨跌幅取 199112、涨跌额取 264648", () => {
  // 真实样本：半导体 881121
  const snap = normalizeRealhead({
    10: "13537.185", 8: "13678.932", 9: "13142.319", 7: "13529.147", 6: "13627.105",
    13: "2622308600.000", 19: "179804330000.000",
    199112: "-0.66", 264648: "-89.920"
  });
  assert.equal(snap.latest, 13537.185);
  assert.equal(snap.preClose, 13627.105);
  assert.equal(snap.changePct, -0.66, "涨跌幅必须取 199112");
  assert.equal(snap.change, -89.92, "涨跌额必须取 264648");
  assert.equal(snap.changePctResolved, -0.66);
  assert.ok(snap.volume > 0 && snap.amount > 0);
});

test("realhead 缺涨跌幅时用现价/昨收推算", () => {
  const snap = normalizeRealhead({ 10: "110", 6: "100" });
  assert.equal(snap.changePct, null);
  assert.ok(Math.abs(snap.changePctResolved - 10) < 1e-9, `应为 +10%，实际 ${snap.changePctResolved}`);
});

test("板块成分表解析：取代码/名称/现价/涨跌幅/换手", () => {
  const html = `<table class="m-table m-pager-table"><tr><th>序号</th><th>代码</th></tr>
    <tr><td>1</td><td>301666</td><td>大普微</td><td>328.51</td><td>20.00</td><td>54.75</td><td>0.00</td><td>21.83</td><td>2.51</td></tr>
    <tr><td>2</td><td>688582</td><td>芯动联科</td><td>35.28</td><td>14.92</td><td>4.58</td><td>0.00</td><td>2.52</td><td>2.21</td></tr>
  </table>`;
  const rows = parseThsSectorMembers(html);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, "301666");
  assert.equal(rows[0].name, "大普微");
  assert.equal(rows[0].latest, 328.51);
  assert.equal(rows[0].changePct, 20);
  assert.equal(rows[0].turnover, 21.83);
});

test("成分表解析：非数字行与非法代码被跳过", () => {
  const html = `<table class="m-table m-pager-table">
    <tr><td>序号</td><td>代码</td><td>名称</td></tr>
    <tr><td>1</td><td>abc</td><td>坏行</td><td>1</td><td>1</td><td>1</td><td>0</td><td>1</td><td>1</td></tr>
    <tr><td>2</td><td>600519</td><td>贵州茅台</td><td>1324.97</td><td>-4.03</td><td>-55.7</td><td>0</td><td>1.2</td><td>1.1</td></tr>
  </table>`;
  const rows = parseThsSectorMembers(html);
  assert.equal(rows.length, 1, "只有合法代码的行被保留");
  assert.equal(rows[0].code, "600519");
});

// ── 概念板块（/gn/ 的 gnSection）──────────────────────────────────────────

test("概念板块解析：从 gnSection 取出 platecode/cid/名称/涨跌幅/净流入", () => {
  const { parseThsConceptSection } = require("./ths-quote.cjs");
  // 真实结构片段（白酒概念）
  const html = `<input type="hidden" id="gnSection" value='{
    "2":{"platecode":"885525","platename":"\u767d\u9152\u6982\u5ff5","cid":"301496","199112":-0.41,"zjjlr":11.09,"zfl":42},
    "4":{"platecode":"886101","platename":"\u5175\u88c5\u91cd\u7ec4\u6982\u5ff5","cid":"309185","199112":4.75,"zjjlr":6.16,"zfl":51}
  }'>`;
  const rows = parseThsConceptSection(html);
  assert.equal(rows.length, 2);
  // 按涨幅降序：4.75 在前
  assert.equal(rows[0].name, "兵装重组概念");
  assert.equal(rows[0].platecode, "886101");
  assert.equal(rows[0].changePct, 4.75);
  assert.equal(rows[1].name, "白酒概念");
  assert.equal(rows[1].platecode, "885525");
  assert.equal(rows[1].cid, "301496");
});

test("★ 概念板块的指数代码是 platecode(885xxx)，不是 cid(30xxxx)", () => {
  const { parseThsConceptSection } = require("./ths-quote.cjs");
  const html = `<input type="hidden" id="gnSection" value='{"1":{"platecode":"885525","platename":"X","cid":"301496","199112":1}}'>`;
  const [row] = parseThsConceptSection(html);
  // 这个区分极其重要：拿 cid 去 d.10jqka.com.cn 查行情会 404，
  // 拿 cid 去 /thshy/detail/code/ 取成分也会解析失败。
  assert.match(row.platecode, /^88\d{4}$/, "platecode 必须是 88xxxx 指数代码");
  assert.match(row.cid, /^30\d{4}$/, "cid 是页面路由代码");
  assert.notEqual(row.platecode, row.cid);
});

test("gnSection 缺失或非法时返回空数组而不是抛错", () => {
  const { parseThsConceptSection } = require("./ths-quote.cjs");
  assert.deepEqual(parseThsConceptSection("<html>没有数据</html>"), []);
  assert.deepEqual(parseThsConceptSection(`<input id="gnSection" value='{bad json}'>`), []);
});

const ths = require("./ths-quote.cjs");
const { getEventListeners } = require("node:events");
const cancelled = () => Object.assign(new Error("synthetic parent cancellation"), { name: "AbortError" });
const fundPage = '<tr><td>1</td><td>Industry</td><td>100</td><td>1</td><td>2</td><td>1</td><td>1</td><td>10</td></tr>';

for (const [name, invoke] of [
  ["text", (fetch, signal) => ths.fetchThsText(fetch, "https://fixture.invalid/text", "utf-8", "", 1000, { signal })],
  ["sector snapshot", (fetch, signal) => ths.fetchThsSectorSnapshot(fetch, "881121", { signal })],
  ["stock snapshot", (fetch, signal) => ths.fetchThsStockSnapshot(fetch, "600000", { signal })],
  ["daily index", (fetch, signal) => ths.fetchThsDailyHistory(fetch, "881121", { signal })],
  ["members", (fetch, signal) => ths.fetchThsSectorMembers(fetch, "881121", { signal })],
  ["concept board", (fetch, signal) => ths.fetchThsConceptBoard(fetch, 1000, { signal })],
  ["concept lookup", (fetch, signal) => ths.findThsConcept(fetch, "fixture", { signal })],
  ["yearly index", (fetch, signal) => ths.fetchThsYearlyHistory(fetch, "881121", 2025, { signal })],
  ["multi-year index", (fetch, signal) => ths.fetchThsMultiYearHistory(fetch, "881121", { signal })],
  ["industry funds", (fetch, signal) => ths.fetchThsFundFlow(fetch, "industry", { signal })]
]) test(`already cancelled ${name} does not start transport`, async () => {
  const controller = new AbortController(), reason = cancelled();
  controller.abort(reason);
  let requests = 0;
  await assert.rejects(invoke(async () => { requests++; throw new Error("transport must not start"); }, controller.signal), error => error === reason);
  assert.equal(requests, 0);
});

for (const [name, invoke] of [
  ["daily index", (fetch, signal) => ths.fetchThsDailyHistory(fetch, "881121", { signal })],
  ["industry funds", (fetch, signal) => ths.fetchThsFundFlow(fetch, "industry", { signal })]
]) test(`active ${name} forwards parent cancellation to transport`, async () => {
  const controller = new AbortController(), reason = cancelled();
  let transportSignal, release;
  const gate = new Promise(resolve => { release = resolve; });
  const request = invoke(async (_url, options) => {
    transportSignal = options.signal;
    await gate;
    return new Response('callback({"data":"20251024,1,1,1,1,1,1"})');
  }, controller.signal);
  const outcome = request.then(() => null, error => error);
  try {
    controller.abort(reason);
    assert.equal(transportSignal.aborted, true);
    assert.equal(transportSignal.reason, reason);
  } finally { release(); await outcome; }
  assert.equal(await outcome, reason);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

test("fund pagination stops when the parent is cancelled during its first body", async () => {
  const controller = new AbortController(), reason = cancelled();
  let requests = 0;
  const fetch = async () => {
    requests++;
    const response = new Response(fundPage);
    controller.abort(reason);
    return response;
  };
  await assert.rejects(ths.fetchThsFundFlow(fetch, "industry", { signal: controller.signal, maxPages: 3 }), error => error === reason);
  assert.equal(requests, 1);
});

test("member pagination and multi-year fallback do not swallow parent cancellation", async () => {
  for (const invoke of [
    (fetch, signal) => ths.fetchThsSectorMembers(fetch, "881121", { signal }),
    (fetch, signal) => ths.fetchThsMultiYearHistory(fetch, "881121", { signal, years: 3 })
  ]) {
    const controller = new AbortController(), reason = cancelled();
    let requests = 0;
    await assert.rejects(invoke(async () => { requests++; controller.abort(reason); throw reason; }, controller.signal), error => error === reason);
    assert.equal(requests, 1);
  }
});

test("text timeout remains independent of the parent and removes abort listeners", async () => {
  const controller = new AbortController();
  let transportSignal, release;
  const physical = new Promise(resolve => { release = resolve; });
  try {
    await assert.rejects(ths.fetchThsText((_url, options) => {
      transportSignal = options.signal;
      return physical;
    }, "https://fixture.invalid/timeout", "utf-8", "", 20, { signal: controller.signal }), { code: "THS_TIMEOUT" });
    assert.equal(controller.signal.aborted, false);
    assert.equal(transportSignal.aborted, true);
    assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  } finally {
    release(new Response(''));
    await ths.drainThsQuoteRequests();
  }
});

test("a transport that synchronously cancels its producer still retains its explicit physical drain", async () => {
  const runtime = require("./service-runtime.cjs").createServiceRuntime();
  let release;
  const physical = new Promise(resolve => { release = resolve; });
  const pending = runtime.run("single", "synchronous-ths-abort", { owner: "ths", requestId: "synchronous" }, () =>
    ths.fetchThsText(() => {
      runtime.cancel({ owner: "ths", requestId: "synchronous" });
      return Object.defineProperty(Promise.reject(runtime.signal().reason), "drained", { value: physical });
    }, "https://fixture.invalid/synchronous", "utf-8", "", 1000, { signal: runtime.signal() }));
  try {
    await assert.rejects(pending, { code: "JOB_CANCELLED" });
    let drained = false;
    pending.drained.then(() => { drained = true; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(drained, false);
    assert.equal(runtime.getDiagnostics().jobs.active, 1);
  } finally {
    release();
    await pending.drained;
    await ths.drainThsQuoteRequests();
    await runtime.shutdown();
  }
});
