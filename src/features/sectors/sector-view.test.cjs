"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, test } = require("node:test");
const React = require("react");
const { renderToStaticMarkup } = require("react-dom/server");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const { createHookHarness, find, button, text, walk } = require("../../../qa/research-hook-harness.cjs");

const previousCssLoader = require.extensions[".css"];
require.extensions[".css"] = () => {};
const restoreTypeScript = registerTypeScript();
const { MEMBER_PAGE_SIZE, SectorGainersTable, SectorMemberTable, SectorView, orderSectorMembers, formatSectorFlow, conceptBoardRows } = require("./SectorView.tsx");

test("sector feature preserves the search shell, refresh state, and last-good-data warning", () => {
  const markup = renderToStaticMarkup(React.createElement(SectorView, {
    rows: [],
    loading: true,
    loadError: "行情源暂不可用",
    onRefresh: async () => false,
    onOpenStock() {}
  }));

  for (const marker of ["板块强度", "搜索任意板块", "刷新板块排行", "行情源暂不可用", "正在加载板块涨幅排行"]) {
    assert.ok(markup.includes(marker), `missing sector page marker: ${marker}`);
  }
  assert.doesNotMatch(markup, /正在构建主线画像|同步实时行情、历史K线、板块与公告/);
});

after(() => {
  restoreTypeScript?.();
  if (previousCssLoader) require.extensions[".css"] = previousCssLoader;
  else delete require.extensions[".css"];
});

// ── B-09 / B-10：成分股明细改为原生表格 + 50 行分页 ─────────────────────────
const memberFixture = (count) => Array.from({ length: count }, (_, index) => ({
  code: "6" + String(index).padStart(5, "0"),
  name: "样本" + index,
  latest: 10 + index / 10,
  changePct: index - 60,
  turnover: 1.5,
  amount: 1.2e8,
  mainNetInflow: index % 2 ? 1.2e8 : null,
  quoteStatus: "ok",
  limitStatusKnown: true,
  isLimitUp: false
}));

test("member table uses native table semantics and renders 50 rows with a load-more action", () => {
  const members = orderSectorMembers(memberFixture(120), "all", "");
  const html = renderToStaticMarkup(React.createElement(SectorMemberTable, {
    members,
    limit: MEMBER_PAGE_SIZE,
    exchangeBoard: false,
    emptyText: "本次未取得成分股，请重试",
    onOpenStock() {},
    onLoadMore() {}
  }));
  assert.equal(MEMBER_PAGE_SIZE, 50, "north-exchange roster must page from 50 rows, not 1000");
  assert.match(html, /^<table style="display:block;width:100%">/);
  assert.match(html, /<thead style="display:block">/);
  assert.match(html, /<th scope="col"[^>]*>股票<\/th>/);
  assert.match(html, /<th scope="col"[^>]*aria-sort="descending"[^>]*><button type="button" class="column-sort-button active"[^>]*>涨幅 ▾<\/button><\/th>/);
  for (const label of ["最新价", "换手", "成交额", "主力净流入"]) {
    assert.match(html, new RegExp(`<th scope="col"[^>]*aria-sort="none"[^>]*><button type="button" class="column-sort-button"[^>]*>${label}<\\/button>`), `${label} is a sortable header`);
  }
  assert.match(html, /<th scope="row"/);
  assert.match(html, /<tbody style="display:block">/);
  assert.equal((html.match(/<tr class="member-row">/g) || []).length, MEMBER_PAGE_SIZE, "first page renders exactly 50 rows");
  assert.match(html, /加载更多（还有 70 只，共 120 只）/);
  assert.match(html, /<th scope="row"[^>]*><button type="button"[^>]*><span[^>]*><b>样本119<\/b>/, "stock name is an in-row button, not a giant row button");
  assert.doesNotMatch(html, /<button[^>]*class="member-row"/, "rows must not be giant buttons any more");
});

test("member ordering is a pure function: gains first, unknown last, filters by name/code", () => {
  const rows = [
    { code: "600001", name: "甲", changePct: 3 },
    { code: "600002", name: "乙", changePct: null },
    { code: "600003", name: "丙", changePct: -2 },
    { code: "600004", name: "丁", changePct: 0 }
  ];
  assert.deepEqual(orderSectorMembers(rows, "all", "").map((row) => row.code), ["600001", "600004", "600003", "600002"]);
  assert.deepEqual(orderSectorMembers(rows, "up", "").map((row) => row.code), ["600001"]);
  assert.deepEqual(orderSectorMembers(rows, "down", "").map((row) => row.code), ["600003"]);
  assert.deepEqual(orderSectorMembers(rows, "all", "丙").map((row) => row.code), ["600003"]);
  assert.deepEqual(orderSectorMembers(rows, "all", "600002").map((row) => row.code), ["600002"]);
  assert.deepEqual(rows.map((row) => row.code), ["600001", "600002", "600003", "600004"], "input must not be reordered in place");
});

// ── B-09 / B-12：板块涨幅排行改为原生表格 ───────────────────────────────────
test("sector ranking uses a native table with aria-sort and an in-row expand button", () => {
  const rows = [
    { rank: 1, code: "881121", name: "半导体", returns: { r1: 3.2 }, memberCount: 142, leaders: [{ name: "中芯国际" }], memberCoverage: { complete: true, loaded: 2 } },
    { rank: 2, code: "881122", name: "元件", returns: { r1: -1.5 }, memberCount: 90, leaders: [] }
  ];
  const html = renderToStaticMarkup(React.createElement(SectorGainersTable, {
    rows,
    expandedName: "半导体",
    detailOrigin: "board",
    expandedRowRef: { current: null },
    onToggle() {},
    renderDetail: () => React.createElement("span", null, "成分股明细")
  }));
  assert.match(html, /^<table class="sector-comparison-table" style="display:block;width:100%">/);
  assert.match(html, /<tr class="sector-row sector-row-head sector-gainers-row">/);
  assert.match(html, /<th scope="col"[^>]*aria-sort="descending"[^>]*><button type="button" class="column-sort-button active"[^>]*>板块涨幅 ▾<\/button><\/th>/);
  assert.match(html, /aria-sort="none"[^>]*><button type="button" class="column-sort-button"[^>]*>资金净流入<\/button>/);
  assert.match(html, /<tr class="sector-row sector-gainers-row active" aria-expanded="true" aria-label="半导体，收起个股">/);
  assert.match(html, /<button type="button" class="sector-expand-label" aria-expanded="true" aria-label="半导体，收起个股" aria-controls="sector-gainers-detail-1"/);
  assert.match(html, /成分股明细/);
  assert.doesNotMatch(html, /<button[^>]*class="sector-row/, "ranking rows must not be giant buttons any more");
});

test("sector page renders a ranking table instead of button rows", () => {
  const html = renderToStaticMarkup(React.createElement(SectorView, {
    rows: [
      { code: "881121", name: "半导体", returns: { r1: 3.2 }, memberCount: 142, leaders: [{ code: "688981", name: "中芯国际" }] },
      { code: "881122", name: "元件", returns: { r1: -1.5 }, memberCount: 90, leaders: [] }
    ],
    loading: false,
    loadError: "",
    onRefresh: async () => false,
    onOpenStock() {}
  }));
  assert.match(html, /<table class="sector-comparison-table"/);
  assert.doesNotMatch(html, /<button[^>]*class="sector-row/);
  assert.equal((html.match(/aria-label="半导体，展开个股"/g) || []).length, 2, "row state + keyboard-reachable expand button");
});

test("sector member filters expose aria-pressed (static guard against dropping the attribute)", () => {
  const source = fs.readFileSync(path.join(__dirname, "SectorView.tsx"), "utf8");
  assert.match(source, /aria-pressed=\{memberFilter === item\.id\}/);
  assert.match(source, /aria-sort=\{ariaSortOf\(sort, sortKey\)\}/);
});

// ── 表头点击排序：第一次从大到小，再点从小到大；没有数值的排最后 ─────────────────
test("column sort toggles largest-first then smallest-first and keeps missing values last", () => {
  const restore = registerTypeScript();
  const { toggleColumnSort, sortRowsBy, ariaSortOf } = require("../../domain/columnSort.ts");
  restore?.();
  let sort = { key: "changePct", direction: "desc" };
  sort = toggleColumnSort(sort, "amount");
  assert.deepEqual(sort, { key: "amount", direction: "desc" }, "a new column starts largest first");
  sort = toggleColumnSort(sort, "amount");
  assert.deepEqual(sort, { key: "amount", direction: "asc" });
  sort = toggleColumnSort(sort, "amount");
  assert.deepEqual(sort, { key: "amount", direction: "desc" });
  const rows = [{ id: "a", v: 2 }, { id: "b", v: null }, { id: "c", v: 9 }, { id: "d", v: "5" }, { id: "e", v: undefined }];
  assert.deepEqual(sortRowsBy(rows, (r) => r.v, "desc").map((r) => r.id), ["c", "d", "a", "b", "e"]);
  assert.deepEqual(sortRowsBy(rows, (r) => r.v, "asc").map((r) => r.id), ["a", "d", "c", "b", "e"]);
  assert.equal(ariaSortOf({ key: "amount", direction: "asc" }, "amount"), "ascending");
  assert.equal(ariaSortOf({ key: "amount", direction: "asc" }, "changePct"), "none");
});

async function sectorSearchFixture(run, api = {}, rows = []) {
  const previousWindow = global.window;
  const timers = new Map();
  let timerId = 0;
  global.window = {
    stockApi: { searchSectors: async () => [], ...api },
    setTimeout(callback) { const id = ++timerId; timers.set(id, callback); return id; },
    clearTimeout(id) { timers.delete(id); },
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {}
  };
  const harness = createHookHarness(SectorView, { props: {
    rows, loading: false, loadError: "", onRefresh: async () => false, onOpenStock() {}
  } });
  const field = () => find(harness.tree, node => node.type === "input" && node.props.placeholder?.startsWith("输入 PCB"));
  const edit = value => { field().props.onChange({ target: { value } }); harness.render(); };
  const submit = () => find(harness.tree, node => node.type === "form").props.onSubmit({ preventDefault() {} });
  const runSearchTimer = async () => {
    const callbacks = [...timers.values()]; timers.clear();
    for (const callback of callbacks) await callback();
    await harness.flush();
  };
  try { harness.render(); await harness.flush(); await run({ harness, field, edit, submit, runSearchTimer }); }
  finally { harness.dispose(); global.window = previousWindow; }
}

test("a failed sector search explains unavailable quotes and keeps technical errors collapsed outside the alert", async () => {
  const requests = [];
  const rawError = "Error invoking remote method 'market:analyze-sector': Error: 板块 PCB 暂无行情数据";
  await sectorSearchFixture(async ({ harness }) => {
    button(harness.tree, "PCB").props.onClick();
    await harness.flush(); await harness.flush();
    const alert = find(harness.tree, node => node.props?.role === "alert");
    assert.match(text(alert), /暂未取得 PCB 的板块行情/);
    assert.match(text(alert), /网络|数据/);
    assert.match(text(alert), /名称或代码/);
    assert.match(text(alert), /稍后重试/);
    assert.doesNotMatch(text(alert), /Error|remote method|market:analyze-sector|不存在|未找到/);
    const details = find(harness.tree, node => node.type === "details" && text(node).includes("技术详情"));
    assert.equal(Boolean(details.props.open), false, "technical details are collapsed on first display");
    assert.ok(text(details).includes(rawError), "original cause remains available for troubleshooting");
    assert.equal(walk(alert).includes(details), false, "the alert must not announce the raw technical error");
    assert.equal(text(find(harness.tree, node => node.props?.className === "sector-query-result")), "板块个股PCB返回板块涨幅排行");
    button(harness.tree, "重试加载个股").props.onClick();
    await harness.flush();
    assert.deepEqual(requests.map(request => request.name), ["PCB", "PCB"]);
  }, { analyzeSector: async request => { requests.push(request); throw Error(rawError); } }, [
    { code: "881121", name: "半导体", returns: { r1: 3 } }
  ]);
});

test("retrying a search candidate preserves its code and identity after the query changes", async () => {
  const requests = [];
  await sectorSearchFixture(async ({ harness, edit, submit, runSearchTimer }) => {
    edit("PCB"); await runSearchTimer();
    submit(); await harness.flush();
    edit("机器人");
    button(harness.tree, "重试加载个股").props.onClick();
    await harness.flush();
    assert.deepEqual(requests, [
      { name: "PCB", code: "881270", secid: "90.881270", type: "概念板块" },
      { name: "PCB", code: "881270", secid: "90.881270", type: "概念板块" }
    ]);
    assert.match(text(find(harness.tree, node => node.props?.role === "alert")), /暂未取得 PCB 的板块行情/);
  }, {
    searchSectors: async () => [{ name: "PCB", code: "881270", secid: "90.881270", type: "概念板块" }],
    analyzeSector: async request => { requests.push(request); throw Error("行情超时"); }
  });
});

test("a late failure cannot replace a newer successful sector selection", async () => {
  let rejectFirst;
  await sectorSearchFixture(async ({ harness }) => {
    button(harness.tree, "PCB").props.onClick();
    button(harness.tree, "CPO").props.onClick();
    await harness.flush();
    rejectFirst(Error("Error invoking remote method 'market:analyze-sector': Error: 旧请求超时"));
    await harness.flush();
    assert.equal(walk(harness.tree).filter(node => node.props?.role === "alert").length, 0);
    assert.equal(text(find(harness.tree, node => node.props?.className === "sector-query-result")), "板块个股CPO返回板块涨幅排行");
    assert.ok(text(harness.tree).includes("CPO"));
  }, {
    analyzeSector: request => request.name === "PCB"
      ? new Promise((resolve, reject) => { rejectFirst = reject; })
      : Promise.resolve({ name: "CPO", code: "881280", constituents: [{ code: "300308", name: "中际旭创", changePct: 2 }] })
  });
});

test("a failed ranking refresh gives recovery advice and preserves last good rows without announcing IPC details", () => {
  const rawError = "Error invoking remote method 'market:get-sectors': Error: 网络超时";
  const harness = createHookHarness(SectorView, { runEffects: false, props: {
    rows: [{ name: "半导体", code: "881121", returns: { r1: 3 }, constituents: [] }],
    loading: false, loadError: rawError, onRefresh: async () => false, onOpenStock() {}
  } });
  try {
    harness.render();
    const warning = find(harness.tree, node => node.props?.role === "alert");
    assert.match(text(warning), /暂未取得最新板块排行/);
    assert.match(text(warning), /上一次有效结果/);
    assert.match(text(warning), /重试/);
    assert.doesNotMatch(text(warning), /Error|remote method|market:get-sectors/);
    const details = find(harness.tree, node => node.type === "details" && text(node).includes("技术详情"));
    assert.equal(Boolean(details.props.open), false);
    assert.ok(text(details).includes(rawError));
    const html = renderToStaticMarkup(harness.tree);
    assert.match(html, /半导体/);
  } finally { harness.dispose(); }
});

test("editing a sector query cannot submit a candidate from the previous query", async () => {
  const requests = [];
  await sectorSearchFixture(async ({ harness, edit, submit, runSearchTimer }) => {
    edit("半导体"); await runSearchTimer();
    edit("PCB"); submit(); await harness.flush();
    assert.deepEqual(requests.map(request => typeof request === "string" ? request : request.name), ["PCB"]);
  }, { searchSectors: async () => [{ code: "881121", name: "半导体" }], analyzeSector: async request => { requests.push(request); return { name: request.name, constituents: [] }; } });
});

test("an in-flight sector search is invalidated before the next render after editing", async () => {
  let resolveOld;
  const requests = [];
  await sectorSearchFixture(async ({ harness, field, edit, submit, runSearchTimer }) => {
    edit("半导体");
    const oldSearch = runSearchTimer();
    // Complete the old request after the input event but before React's next effect.
    field().props.onChange({ target: { value: "PCB" } });
    resolveOld([{ code: "881121", name: "半导体" }]);
    await oldSearch; await harness.flush();
    assert.equal(walk(harness.tree).filter(node => node.props?.className === "sector-suggestions").length, 0);
    submit(); await harness.flush();
    assert.deepEqual(requests.map(request => request.name), ["PCB"]);
  }, { searchSectors: () => new Promise(resolve => { resolveOld = resolve; }), analyzeSector: async request => { requests.push(request); return { name: request.name, constituents: [] }; } });
});

test("sector flows drop false precision and concept rows open as concept boards", () => {
  assert.equal(formatSectorFlow(24_000_000), "+2400 万");
  assert.equal(formatSectorFlow(-60_000_000), "-6000 万");
  assert.equal(formatSectorFlow(2_372_000_000), "+23.72 亿");
  assert.equal(formatSectorFlow(null), "--");
  const [row] = conceptBoardRows([{ kind: "concept", id: "ths:concept:301558", code: "301558", conceptCid: "301558", indexCode: "885710", name: "固态电池", changePct: 3.1,
    netInflow: 8e8, memberCount: null, leaderName: "", limitUps: 2, limitUpStocks: [{ code: "600001", name: "甲" }, { code: "600002", name: "乙" }] }]);
  assert.equal(row.boardType, "concept");
  assert.equal(row.code, "885710");
  assert.equal(row.poolLimitUps, 2);
  assert.deepEqual(row.leaders.map(item => item.name), ["甲", "乙"]);
  const markup = renderToStaticMarkup(React.createElement(SectorGainersTable, { rows: [row], expandedName: "", detailOrigin: "board", expandedRowRef: { current: null }, onToggle: () => {}, renderDetail: () => null }));
  assert.match(markup, /2 家/);
  assert.match(markup, /\+8\.00 亿/);
});
