"use strict";
// AI 问股（1.6.53）：回答的 Markdown 解析与页面纯逻辑。
const assert = require("node:assert/strict");
const { after, test } = require("node:test");
const { registerTypeScript } = require("../../../qa/register-typescript.cjs");
const restore = registerTypeScript();
after(() => restore?.());
const md = require("./agentMarkdown.ts");
const model = require("./agentModel.ts");

test("answers parse into headings, lists, tables, quotes and rules without any HTML", () => {
  const blocks = md.parseAgentMarkdown([
    "**结论：偏多**", "", "## 技术面", "- 5 日 +3.2%", "  - 量比 1.3", "- RSI 52", "", "1. 第一步", "2. 第二步", "",
    "| 类型 | 价位 |", "|:---|---:|", "| 支撑 | 1490 |", "", "> 引用一行", "", "---", "<script>alert(1)</script>"
  ].join("\n"));
  assert.deepEqual(blocks.map(block => block.type), ["paragraph", "heading", "list", "list", "table", "quote", "rule", "paragraph"]);
  assert.deepEqual(blocks[0].lines[0], [{ type: "strong", text: "结论：偏多" }]);
  assert.equal(blocks[1].level, 3);
  assert.equal(blocks[2].items.length, 2);
  assert.equal(blocks[2].items[0].children.items.length, 1, "indented items nest one level");
  assert.deepEqual(blocks[2].items[0].inline, [{ type: "text", text: "5 日 " }, { type: "up", text: "+3.2%" }]);
  assert.equal(blocks[3].ordered, true);
  assert.deepEqual(blocks[4].align, ["left", "right"]);
  assert.deepEqual(blocks[4].rows[0].map(cell => cell[0].text), ["支撑", "1490"]);
  assert.deepEqual(blocks[7].lines[0], [{ type: "text", text: "<script>alert(1)</script>" }], "HTML stays plain text");
});

test("only explicitly signed percentages are colored and ranges stay plain", () => {
  assert.deepEqual(md.parseInline("涨 +2.5%，跌 -1.2%，区间 3-5%，`代码` **加粗**").map(node => node.type), ["text", "up", "text", "down", "text", "code", "text", "strong"]);
  assert.equal(md.parseInline("区间 3-5%").length, 1);
  assert.equal(md.markdownToPlainText("## 标题\n**结论**：好\n| a | b |\n|---|---|\n| 1 | 2 |"), "标题\n结论：好\na  b\n1  2");
});

test("page helpers: quick tasks, stance colors, step summaries and the stock-page hand-off", () => {
  const focus = { code: "600519", name: "贵州茅台" };
  const full = model.QUICK_TASKS.find(task => task.id === "full");
  assert.match(full.prompt(focus), /全面分析一下贵州茅台/);
  const holding = model.QUICK_TASKS.find(task => task.id === "holding");
  assert.equal(holding.send, false, "holding diagnosis waits for the cost price");
  assert.equal(model.QUICK_TASKS.find(task => task.id === "market").needsStock, false);
  assert.equal(model.stanceTone("偏多"), "up");
  assert.equal(model.stanceTone("偏空"), "down");
  assert.equal(model.stanceTone("回避"), "warn");
  assert.equal(model.stepsSummary([{ kind: "tools", thought: "", calls: [{ tool: "quote", name: "实时行情", args: "", status: "ok", summary: "" }, { tool: "news", name: "相关资讯", args: "", status: "failed", summary: "" }] }]),
    "查了 2 项数据：实时行情、相关资讯（1 项没取到）");
  assert.equal(model.formatDuration(83000), "1 分 23 秒");
  assert.equal(model.focusFromSecurity({ code: "512690", name: "酒ETF", assetType: "etf" }), null);
  assert.deepEqual(model.focusFromSecurity({ code: "600519", name: " 贵州 茅台 " }), { code: "600519", name: "贵州茅台" });
  assert.equal(model.shortTime("2026-11-06T02:49:00.000Z", new Date("2026-11-06T05:00:00.000Z")), "10:49");
  assert.equal(model.shortTime("2026-10-01T02:49:00.000Z", new Date("2026-11-06T05:00:00.000Z")), "10月1日");
  const messages = [{ id: "a", role: "user", content: "问1" }, { id: "b", role: "assistant", content: "失败", error: true }];
  assert.equal(model.questionBefore(messages, "b").content, "问1");

  assert.equal(model.canOpenAgent(), false);
  assert.equal(model.openAgentFor(focus), false, "no opener outside the main window");
  let opened = 0;
  model.registerAgentOpener(() => { opened += 1; });
  assert.equal(model.openAgentFor(focus), true);
  assert.equal(opened, 1);
  assert.deepEqual(model.takeAgentHandoff(), { focus, task: "full" });
  assert.equal(model.takeAgentHandoff(), null, "the hand-off is used once");
  model.registerAgentOpener(null);
});

test("skill helpers: toggle within the limit, verdict colors and custom-skill checks", () => {
  assert.deepEqual(model.toggleSkill([], "a"), ["a"]);
  assert.deepEqual(model.toggleSkill(["a", "b"], "a"), ["b"]);
  assert.deepEqual(model.toggleSkill(["a", "b", "c"], "d"), ["a", "b", "c"], "a fourth skill is not added");
  assert.deepEqual(["符合", "接近", "不符合", "不适用", "乱写"].map(model.verdictTone), ["yes", "near", "no", "na", "na"]);
  assert.match(model.skillDraftProblem({ name: " ", method: "缩量回踩十日线", tools: [] }), /名字/);
  assert.match(model.skillDraftProblem({ name: "尾盘", method: "回踩", tools: [] }), /判断要点/);
  assert.match(model.skillDraftProblem({ name: "尾盘", method: "尾盘回踩均价线", tools: ["a", "b", "c", "d", "e", "f", "g"] }), /最多选 6 项/);
  assert.equal(model.skillDraftProblem({ name: "尾盘", method: "尾盘回踩均价线", tools: ["kline"] }), "");
});

// Exercise the real page and its hooks; only the IPC/document/timer boundary is
// replaced. Deferred replies force a render at the same boundary as real IPC.
const { createHookHarness, walk, find, button } = require("../../../qa/research-hook-harness.cjs");
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const A_STOCK = { code: "600519", name: "贵州茅台" };
const B_STOCK = { code: "300750", name: "宁德时代" };
const at = "2026-11-06T02:00:00.000Z";
const conversation = (id, focus, content) => ({ id, title: id, focus, createdAt: at, updatedAt: at, messages: [{ id: `${id}-question`, role: "user", content, focus, at }] });

async function agentFixture(t, options = {}) {
  const previousWindow = global.window, previousDocument = global.document;
  const timers = new Map(), calls = { start: [], poll: [], conversation: [], cancel: [] };
  const conversations = new Map([["B", conversation("B", B_STOCK, "B 的问题")], ...(options.existingA ? [["A", conversation("A", A_STOCK, "A 的原问题")]] : [])]);
  const runs = new Map();
  let sequence = 0;
  const state = () => ({ configured: true, model: "offline", profileName: "离线", profileId: "", activeProfileId: "p", profiles: [{ id: "p", name: "离线", model: "offline" }], memory: "", tools: [], skillIds: [],
    conversations: [...conversations.values()].map(value => ({ id: value.id, title: value.title, focus: value.focus, createdAt: at, updatedAt: at, turns: value.messages.filter(item => item.role === "user").length, running: Boolean(value.runningRunId) })) });
  const createRun = input => {
    const id = input.conversationId || "A";
    const value = conversations.get(id) || { ...conversation(id, input.focus || null, ""), messages: [] };
    const runId = `run-${++sequence}`;
    value.messages.push({ id: `question-${sequence}`, role: "user", content: input.message, focus: input.focus || null, at });
    value.runningRunId = runId;
    conversations.set(id, value);
    runs.set(runId, { runId, conversationId: id, status: "running", steps: [], startedAt: at, elapsedMs: 0, model: "offline" });
    return { runId, conversationId: id };
  };
  const api = {
    state: async () => state(),
    conversation: async id => { calls.conversation.push(id); return options.read ? options.read(id, () => structuredClone(conversations.get(id) || null)) : structuredClone(conversations.get(id) || null); },
    start: async input => { calls.start.push(input); return options.start ? options.start(input, createRun) : createRun(input); },
    poll: async id => { calls.poll.push(id); return options.poll ? options.poll(id, runs.get(id)) : structuredClone(runs.get(id)); },
    cancel: async id => { calls.cancel.push(id); return null; },
    remove: async id => { conversations.delete(id); return state(); },
    settings: async input => options.settings ? options.settings(input, state) : state()
  };
  global.window = { stockApi: { ai: { agent: api } }, setInterval(callback) { const id = ++sequence; timers.set(id, callback); return id; }, clearInterval(id) { timers.delete(id); }, requestAnimationFrame: callback => callback() };
  global.document = { hidden: false };
  delete require.cache[require.resolve("./AiAgentView.tsx")];
  // Each fixture represents a fresh application session. The hook remembers the
  // selected conversation across route mounts within one session.
  try { delete require.cache[require.resolve("./useAgentConversation.ts")]; } catch { /* pre-fix RED run has no extracted hook */ }
  const Page = require("./AiAgentView.tsx").default;
  const hooks = createHookHarness(Page);
  t.after(() => { hooks.dispose(); global.window = previousWindow; global.document = previousDocument; });
  const part = name => find(hooks.tree, node => typeof node.type === "function" && node.type.name === name);
  const flush = async () => { await hooks.flush(); await hooks.flush(); };
  const open = async id => { find(hooks.tree, node => node.type === "button" && node.props.title === id).props.onClick(); await flush(); };
  const draft = text => { part("Composer").props.onChange(text); hooks.render(); };
  const send = async text => { draft(text); part("Composer").props.onSend(); await flush(); };
  const tick = async () => { for (const callback of [...timers.values()]) callback(); await flush(); };
  hooks.render(); await flush();
  return { hooks, calls, conversations, runs, api, timers, part, flush, open, draft, send, tick,
    bubbles: () => walk(hooks.tree).filter(node => node.props?.className === "ai-agent-bubble").map(node => node.props.children),
    answers: () => walk(hooks.tree).filter(node => typeof node.type === "function" && node.type.name === "AnswerCard"),
    active: () => walk(hooks.tree).find(node => node.props?.["aria-current"] === "true")?.props.title };
}

for (const status of ["done", "error", "cancelled"]) test(`delayed ${status} history retains the terminal answer after a render`, async t => {
  const finalRead = deferred(); let terminal = false;
  const h = await agentFixture(t, { read: (id, read) => id === "A" && terminal ? finalRead.promise : read() });
  h.part("StockPicker").props.onChange(A_STOCK); h.hooks.render();
  await h.send("A 的新问题");
  const run = [...h.runs.values()][0];
  const answer = { id: "result", role: "assistant", content: `${status} 结果`, at, ...(status !== "done" ? { error: true } : {}), ...(status === "cancelled" ? { cancelled: true } : {}) };
  h.runs.set(run.runId, { ...run, status, message: answer });
  terminal = true;
  await h.tick();
  h.hooks.render();
  finalRead.resolve({ ...conversation("A", A_STOCK, "A 的新问题"), messages: [conversation("A", A_STOCK, "A 的新问题").messages[0], answer] });
  await h.flush();
  assert.equal(h.answers().length, 1, "the terminal message must reach the active conversation");
  assert.equal(h.answers()[0].props.message.content, `${status} 结果`);
  assert.equal(h.part("Composer").props.running, false);
  assert.equal(h.answers()[0].props.latest, true);
  if (status !== "done") {
    const card = h.answers()[0]; const child = createHookHarness(card.type, { props: card.props }); child.render();
    const retry = button(child.tree, "重试"); assert.equal(retry.props.disabled, false); retry.props.onClick(); await h.flush(); child.dispose();
    assert.equal(h.calls.start[1].message, "A 的新问题", "retry sends the failed question");
  }
});

test("switching conversations during a terminal read keeps B messages, focus and draft", async t => {
  const finalRead = deferred(); let terminal = false;
  const h = await agentFixture(t, { read: (id, read) => id === "A" && terminal ? finalRead.promise : read() });
  await h.send("A 的新问题");
  const run = [...h.runs.values()][0]; h.runs.set(run.runId, { ...run, status: "done" }); terminal = true;
  await h.tick(); await h.open("B"); h.draft("B 的草稿");
  finalRead.resolve({ ...conversation("A", A_STOCK, "A 的新问题"), messages: [{ id: "old-answer", role: "assistant", content: "A 的旧结果", at }] }); await h.flush();
  assert.deepEqual(h.bubbles(), ["B 的问题"]); assert.equal(h.answers().length, 0);
  assert.equal(h.active(), "B"); assert.deepEqual(h.part("StockPicker").props.focus, B_STOCK); assert.equal(h.part("Composer").props.value, "B 的草稿");
});

for (const stage of ["start", "history"]) test(`navigation during ${stage} keeps B and its next-send destination; A can reopen`, async t => {
  const pending = deferred(); let holdA = true, completeStart;
  const h = await agentFixture(t, {
    start: stage === "start" ? (input, create) => { if (input.message === "A 的新问题") { completeStart = () => pending.resolve(create(input)); return pending.promise; } return create(input); } : undefined,
    read: (id, read) => stage === "history" && id === "A" && holdA ? pending.promise : read()
  });
  h.part("StockPicker").props.onChange(A_STOCK); h.hooks.render(); await h.send("A 的新问题");
  await h.open("B"); h.draft("B 的草稿");
  if (stage === "start") completeStart(); else pending.resolve(structuredClone(h.conversations.get("A")));
  holdA = false; await h.flush();
  assert.deepEqual(h.bubbles(), ["B 的问题"]); assert.equal(h.active(), "B");
  assert.deepEqual(h.part("StockPicker").props.focus, B_STOCK); assert.equal(h.part("Composer").props.value, "B 的草稿");
  assert.equal(h.part("Composer").props.sending, false); assert.equal(h.part("Composer").props.running, false);
  await h.send("B 的追问");
  assert.equal(h.calls.start[1].conversationId, "B"); assert.deepEqual(h.calls.start[1].focus, B_STOCK);
  await h.open("A");
  assert.deepEqual(h.bubbles(), ["A 的新问题"]); assert.deepEqual(h.part("StockPicker").props.focus, A_STOCK);
  assert.equal(h.part("Composer").props.running, true, "navigation must preserve the service's background run");
  assert.deepEqual(h.calls.cancel, []);
});

for (const stage of ["start", "history"]) test(`stale ${stage} rejection and finally cannot change B's in-flight send`, async t => {
  const old = deferred(), current = deferred();
  const h = await agentFixture(t, {
    start: (input, create) => input.message === "A 的新问题" ? (stage === "start" ? old.promise : create(input)) : current.promise,
    read: (id, read) => stage === "history" && id === "A" ? old.promise : read()
  });
  await h.send("A 的新问题"); await h.open("B"); await h.send("B 的追问");
  assert.equal(h.calls.start.length, 2, "B can send while A's earlier UI request is pending");
  old.reject(new Error("A 的延迟错误")); await h.flush();
  assert.equal(h.part("Composer").props.sending, true, "A's finally must not release B's send lock");
  assert.equal(h.part("Composer").props.value, "B 的追问"); assert.deepEqual(h.bubbles(), ["B 的问题"]);
  assert.equal(walk(h.hooks.tree).some(node => node.props?.className === "warning-banner ai-agent-error"), false);
  current.reject(new Error("B 的当前错误")); await h.flush();
  assert.equal(h.part("Composer").props.sending, false);
  assert.match(require("../../../qa/research-hook-harness.cjs").text(h.hooks.tree), /B 的当前错误/);
});

test("deleting the active conversation invalidates its pending send history", async t => {
  const history = deferred(); let hold = false;
  const h = await agentFixture(t, { existingA: true, read: (id, read) => id === "A" && hold ? history.promise : read() });
  await h.open("A"); hold = true; await h.send("待删除的问题");
  find(h.hooks.tree, node => node.props?.["aria-label"] === "删除「A」").props.onClick(); h.hooks.render();
  find(h.hooks.tree, node => node.props?.["aria-label"] === "确认删除「A」").props.onClick(); await h.flush();
  history.resolve(conversation("A", A_STOCK, "已经删除的问题")); await h.flush();
  assert.deepEqual(h.bubbles(), []); assert.equal(h.active(), undefined);
  assert.equal(h.part("Composer").props.running, false); assert.equal(h.part("Composer").props.sending, false);
});

test("polls and final history reads never overlap and stay paused while hidden", async t => {
  const poll = deferred(), history = deferred(); let terminal = false;
  const h = await agentFixture(t, { poll: () => poll.promise, read: (id, read) => id === "A" && terminal ? history.promise : read() });
  await h.send("A 的新问题");
  await h.tick(); await h.tick(); assert.equal(h.calls.poll.length, 1, "an unresolved poll owns the polling slot");
  const run = [...h.runs.values()][0]; terminal = true; poll.resolve({ ...run, status: "done" }); await h.flush();
  await h.tick(); assert.equal(h.calls.poll.length, 1, "final history shares the polling slot");
  history.resolve(conversation("A", A_STOCK, "A 的新问题")); await h.flush();
  terminal = false;
  global.document.hidden = true; await h.open("A"); await h.tick(); assert.equal(h.calls.poll.length, 1);
  global.document.hidden = false; await h.tick(); assert.equal(h.calls.poll.length, 2);
});

test("unmount invalidates pending start without cancelling its background service run", async t => {
  const start = deferred(); let finish;
  const h = await agentFixture(t, { start: (input, create) => { finish = () => start.resolve(create(input)); return start.promise; } });
  await h.send("A 的新问题"); h.hooks.dispose(); const reads = h.calls.conversation.length;
  finish(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(h.calls.conversation.length, reads, "a late start must not issue new UI reads after unmount");
  assert.equal(h.conversations.get("A").messages[0].content, "A 的新问题"); assert.deepEqual(h.calls.cancel, []);
  assert.equal(h.timers.size, 0);
});

test("an unsaved answer remains readable and persistence retry clears the warning only after acknowledgement", async t => {
  let attempts = 0;
  const h = await agentFixture(t, { settings: async (_input, state) => { attempts += 1; if (attempts === 1) throw new Error("磁盘仍不可写"); delete h.conversations.get("A").persistenceError; delete h.conversations.get("A").messages.at(-1).persistenceError; return state(); } });
  await h.send("A 的新问题"); const run = [...h.runs.values()][0];
  const message = { id: "unsaved-answer", role: "assistant", content: "已经生成的回答", at, persistenceError: "对话保存失败" };
  const value = h.conversations.get("A"); delete value.runningRunId; value.messages.push(message); value.persistenceError = "对话保存失败";
  h.runs.set(run.runId, { ...run, status: "done", message, persistenceError: "对话保存失败" });
  await h.tick();
  assert.equal(h.answers()[0]?.props.message.content, "已经生成的回答");
  let warning = find(h.hooks.tree, node => node.props?.role === "alert" && require("../../../qa/research-hook-harness.cjs").text(node).includes("保存失败"));
  button(warning, "重试保存").props.onClick(); await h.flush();
  assert.equal(h.answers()[0]?.props.message.content, "已经生成的回答");
  warning = find(h.hooks.tree, node => node.props?.role === "alert" && require("../../../qa/research-hook-harness.cjs").text(node).includes("保存失败"));
  button(warning, "重试保存").props.onClick(); await h.flush();
  assert.equal(attempts, 2); assert.equal(h.answers()[0]?.props.message.content, "已经生成的回答");
  assert.equal(walk(h.hooks.tree).some(node => node.props?.role === "alert" && require("../../../qa/research-hook-harness.cjs").text(node).includes("保存失败")), false);
  assert.doesNotMatch(require("../../../qa/research-hook-harness.cjs").text(h.hooks.tree), /磁盘仍不可写/, "successful retry clears its previous error");
});

test("a terminal poll answer survives failed initial and final conversation reads", async t => {
  const h = await agentFixture(t, { read: (id, read) => { if (id === "A") throw new Error("历史读取失败"); return read(); } });
  await h.send("历史不可读时的问题"); const run = [...h.runs.values()][0];
  h.runs.set(run.runId, { ...run, status: "done", message: { id: "poll-answer", role: "assistant", content: "轮询保留的回答", at } });
  await h.tick();
  assert.equal(h.answers()[0]?.props.message.content, "轮询保留的回答");
  assert.deepEqual(h.bubbles(), ["历史不可读时的问题"]); assert.equal(h.part("Composer").props.running, false);
});

test("navigation history must finish before a reply can inherit its destination and stock", async t => {
  const loadingB = deferred();
  const h = await agentFixture(t, { read: (id, read) => id === "B" ? loadingB.promise : read() });
  h.part("StockPicker").props.onChange(A_STOCK); h.hooks.render();
  find(h.hooks.tree, node => node.type === "button" && node.props.title === "B").props.onClick(); await h.flush();
  await h.send("还没读完就发送");
  assert.equal(h.calls.start.length, 0, "an unloaded history cannot mix its ID with the previous stock");
  loadingB.resolve(conversation("B", B_STOCK, "B 的问题")); await h.flush(); await h.send("B 的追问");
  assert.equal(h.calls.start[0].conversationId, "B"); assert.deepEqual(h.calls.start[0].focus, B_STOCK);
});

async function finishUnsavedAnswer(h) {
  const run = [...h.runs.values()].at(-1);
  const value = h.conversations.get(run.conversationId);
  const message = { id: `answer-${run.runId}`, role: "assistant", content: "需要保存的回答", at, persistenceError: "对话保存失败" };
  delete value.runningRunId; value.messages.push(message); value.persistenceError = "对话保存失败";
  h.runs.set(run.runId, { ...run, status: "done", message, persistenceError: "对话保存失败" });
  await h.tick();
}

test("a delayed persistence history snapshot cannot erase a newer question or release its send lock", async t => {
  const savedHistory = deferred(), newHistory = deferred(); let mode = "normal";
  const h = await agentFixture(t, { read: (id, read) => { if (id !== "A") return read(); if (mode === "retry") return savedHistory.promise; if (mode === "new-send") return newHistory.promise; return read(); } });
  await h.send("原问题"); await finishUnsavedAnswer(h);
  const oldSnapshot = structuredClone(h.conversations.get("A")); delete oldSnapshot.persistenceError; delete oldSnapshot.messages.at(-1).persistenceError;
  mode = "retry"; button(h.hooks.tree, "重试保存").props.onClick(); await h.flush();
  mode = "new-send"; await h.send("同会话的新问题");
  assert.equal(h.part("Composer").props.sending, true); assert.equal(h.part("Composer").props.running, true);
  savedHistory.resolve(oldSnapshot); await h.flush();
  assert.deepEqual(h.bubbles(), ["原问题", "同会话的新问题"]);
  assert.equal(h.part("Composer").props.sending, true); assert.equal(h.part("Composer").props.running, true);
  assert.equal(button(h.hooks.tree, "重试保存").props.disabled, false, "superseded retry must release its own saving flag");
  newHistory.resolve(structuredClone(h.conversations.get("A"))); await h.flush();
});

test("a superseded persistence acknowledgement refreshes current sidebar state and preserves the newer send error", async t => {
  const savedState = deferred(); let snapshot, failNewHistory = false;
  const h = await agentFixture(t, {
    settings: (_input, state) => { snapshot = state(); return savedState.promise; },
    read: (id, read) => { if (id === "A" && failNewHistory) throw new Error("新提问的历史读取错误"); return read(); }
  });
  await h.send("原问题"); await finishUnsavedAnswer(h);
  button(h.hooks.tree, "重试保存").props.onClick(); await h.flush();
  failNewHistory = true; await h.send("同会话的新问题");
  savedState.resolve(snapshot); await h.flush();
  assert.match(require("../../../qa/research-hook-harness.cjs").text(h.hooks.tree), /新提问的历史读取错误/);
  const row = find(h.hooks.tree, node => node.type === "button" && node.props.title === "A");
  assert.match(require("../../../qa/research-hook-harness.cjs").text(row), /2 问/, "the stale settings snapshot must not roll back the current sidebar");
  assert.deepEqual(h.bubbles(), ["原问题", "同会话的新问题"]);
  assert.equal(h.part("Composer").props.running, true);
  assert.equal(button(h.hooks.tree, "重试保存").props.disabled, false);
});

test("a persistence retry begun during a run cannot erase its newer terminal answer", async t => {
  const retryRead = deferred(); let mode = "normal";
  const h = await agentFixture(t, { read: (id, read) => {
    if (id !== "A") return read();
    if (mode === "initial-fail") throw new Error("初始历史暂不可读");
    if (mode === "retry") return retryRead.promise;
    return read();
  } });
  await h.send("原问题"); await finishUnsavedAnswer(h);
  mode = "initial-fail"; await h.send("第二个问题");
  const oldSnapshot = structuredClone(h.conversations.get("A"));
  mode = "retry"; button(h.hooks.tree, "重试保存").props.onClick(); await h.flush();
  const run = [...h.runs.values()].at(-1);
  const message = { id: "new-terminal-answer", role: "assistant", content: "新生成的最终回答", at };
  delete h.conversations.get("A").runningRunId; h.conversations.get("A").messages.push(message);
  h.runs.set(run.runId, { ...run, status: "done", message }); mode = "normal";
  await h.tick();
  assert.deepEqual(h.answers().map(card => card.props.message.content), ["需要保存的回答", "新生成的最终回答"]);
  retryRead.resolve(oldSnapshot); await h.flush();
  assert.deepEqual(h.answers().map(card => card.props.message.content), ["需要保存的回答", "新生成的最终回答"]);
  assert.equal(h.part("Composer").props.running, false);
});
