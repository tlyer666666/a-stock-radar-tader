"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const {
  MAIN_IPC_CHANNELS,
  REVIEW_IPC_CHANNELS,
  IPC_EVENT_CHANNELS,
  ALL_IPC_CHANNELS,
  VALIDATED_CHANNELS,
  VALIDATORS,
  OPTIONAL_OBJECT_CHANNELS,
  NO_ARG_CHANNELS,
  validateIpcPayload
} = require("./ipc/contract.cjs");
const { loadElectronIpcSources } = require("../qa/ipc-source-loader.cjs");

function loadTsContractModule() {
  const tsPath = path.resolve(__dirname, "../src/shared/ipc-contract.ts");
  const raw = fs.readFileSync(tsPath, "utf8");
  const { outputText } = ts.transpileModule(raw, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  });
  const mod = { exports: {} };
  vm.runInNewContext(outputText, { module: mod, exports: mod.exports });
  return mod.exports;
}

function extractRegisteredChannels() {
  const { ipcEntries } = loadElectronIpcSources();
  const registeredMain = [];
  const registeredReview = [];
  for (const entry of ipcEntries) {
    if (!entry.name.endsWith(".ipc.cjs")) continue;
    const ast = ts.createSourceFile(entry.name, entry.source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    (function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "handleTrustedIpc") {
        const firstArg = node.arguments[0];
        if (firstArg && ts.isStringLiteral(firstArg)) {
          registeredMain.push(firstArg.text);
        }
      }
      if (
        entry.name.endsWith("news-review.ipc.cjs")
        && ts.isCallExpression(node)
        && node.expression.getText(ast) === "Object.entries"
        && node.arguments[0]
        && ts.isObjectLiteralExpression(node.arguments[0])
      ) {
        for (const prop of node.arguments[0].properties) {
          if (ts.isPropertyAssignment(prop) && ts.isStringLiteral(prop.name)) {
            registeredReview.push(prop.name.text);
          }
        }
      }
      ts.forEachChild(node, visit);
    })(ast);
  }
  return {
    registeredMain: registeredMain.sort(),
    registeredReview: registeredReview.sort()
  };
}

test("canonical IPC channel contract matches preload, review-preload, main IPC modules, and TypeScript contract", () => {
  const preloadSource = fs.readFileSync(path.join(__dirname, "preload.cjs"), "utf8");
  const reviewPreloadSource = fs.readFileSync(path.join(__dirname, "review-preload.cjs"), "utf8");

  const preloadChannels = [...new Set([...preloadSource.matchAll(/\binvoke\("([^"]+)"/g)].map(m => m[1]))].sort();
  const reviewPreloadChannels = [...new Set([...reviewPreloadSource.matchAll(/\binvoke\(['"]([^'"]+)['"]/g)].map(m => m[1]))].sort();
  const { registeredMain, registeredReview } = extractRegisteredChannels();
  const tsContract = loadTsContractModule();

  assert.deepEqual(MAIN_IPC_CHANNELS, preloadChannels);
  assert.deepEqual(registeredMain, preloadChannels);
  assert.deepEqual(REVIEW_IPC_CHANNELS, reviewPreloadChannels);
  assert.deepEqual(registeredReview, reviewPreloadChannels);
  assert.equal(ALL_IPC_CHANNELS.length, MAIN_IPC_CHANNELS.length + REVIEW_IPC_CHANNELS.length);

  assert.deepEqual([...tsContract.MAIN_IPC_CHANNELS].sort(), MAIN_IPC_CHANNELS);
  assert.deepEqual([...tsContract.REVIEW_IPC_CHANNELS].sort(), REVIEW_IPC_CHANNELS);
  assert.deepEqual([...tsContract.IPC_EVENT_CHANNELS].sort(), [...IPC_EVENT_CHANNELS].sort());
  assert.deepEqual([...VALIDATED_CHANNELS].sort(), [...ALL_IPC_CHANNELS].sort());
  assert.equal(VALIDATORS.size + OPTIONAL_OBJECT_CHANNELS.size + NO_ARG_CHANNELS.size, ALL_IPC_CHANNELS.length);
});

test("validateIpcPayload enforces structural runtime validation and preserves typed errors", () => {
  assert.throws(() => validateIpcPayload("watchlist:save", ["not-an-array"]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("watchlist:get", [{ unexpected: true }]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("holdings:save", [{}]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("strategy:custom:save", [["array"]]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("strategy:custom:delete", [""]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("service:cancel", ["   "]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("news:analyze-impact", [{ item: "bad" }]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:chart", ["600519", "101", ["bad-options"]]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("backtest:run-portfolio", ["bad-input"]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("backup:run", [["bad"], undefined]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:search", [12345]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("trend-screener:status", [["bad-cursor"]]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:batch-quotes", ["not-an-array"]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:batch-quotes", [[{ code: "600519" }, "bad"]]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:batch-quotes", [[{ code: "12345" }]]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("market:batch-quotes", [Array.from({ length: 1201 }, (_, i) => ({ code: String(600000 + i) }))]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("strategy:leaderboard", ["bad-options"]), { code: "INVALID_IPC_PAYLOAD" });

  assert.doesNotThrow(() => validateIpcPayload("watchlist:get", []));
  assert.doesNotThrow(() => validateIpcPayload("watchlist:save", [[]]));
  assert.doesNotThrow(() => validateIpcPayload("strategy:leaderboard", []));
  assert.doesNotThrow(() => validateIpcPayload("strategy:leaderboard", [{ statusOnly: true }]));
  assert.doesNotThrow(() => validateIpcPayload("market:chart", [{ code: "600519", name: "贵州茅台" }, 101]));
  assert.doesNotThrow(() => validateIpcPayload("market:chart", ["600519", "101", { limit: 120 }]));
  assert.doesNotThrow(() => validateIpcPayload("backtest:run-portfolio", [undefined]));
  assert.doesNotThrow(() => validateIpcPayload("news:analyze-impact", [{ item: { title: "公告" } }]));
  assert.doesNotThrow(() => validateIpcPayload("trend-screener:status", [{ jobId: "t1", offset: 0 }]));
  assert.doesNotThrow(() => validateIpcPayload("agent:poll", ["run-123"]));
  assert.doesNotThrow(() => validateIpcPayload("market:batch-quotes", [[{ code: "600519" }, { code: "920006", thscode: "920006.BJ" }]]));

  // M1: dedicated field-level validators for the 6 new channels
  assert.doesNotThrow(() => validateIpcPayload("alerts:rules", []));
  assert.doesNotThrow(() => validateIpcPayload("alerts:rules", [{ op: "save", rule: { type: "ma_cross" } }]));
  assert.throws(() => validateIpcPayload("alerts:rules", [{ op: "drop_all" }]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("alerts:rules", [{ op: "save" }]), { code: "INVALID_IPC_PAYLOAD" });

  assert.doesNotThrow(() => validateIpcPayload("etf:rotation", [{ pool: ["510300", "510500"], topN: 2, lookback: 60, rebalance: "weekly" }]));
  assert.throws(() => validateIpcPayload("etf:rotation", [{ pool: Array(21).fill("510300") }]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("etf:rotation", [{ topN: 99 }]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("etf:rotation", [{ rebalance: "daily" }]), { code: "INVALID_IPC_PAYLOAD" });

  assert.doesNotThrow(() => validateIpcPayload("screen:factors", [{ strategyId: "quality_value", top: 20 }]));
  assert.throws(() => validateIpcPayload("screen:factors", [{ top: 5000 }]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("screen:factors", [{ strategyId: "x".repeat(41) }]), { code: "INVALID_IPC_PAYLOAD" });

  assert.doesNotThrow(() => validateIpcPayload("agent:feeds", [{ op: "save", name: "财联社", url: "https://example.com/rss", enabled: true }]));
  assert.throws(() => validateIpcPayload("agent:feeds", [{ op: "exec" }]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("agent:feeds", [{ op: "test", url: "https://example.com/" + "a".repeat(500) }]), { code: "INVALID_IPC_PAYLOAD" });

  assert.doesNotThrow(() => validateIpcPayload("agent:signals", [{ status: "active", code: "600519", evaluate: true }]));
  assert.throws(() => validateIpcPayload("agent:signals", [{ status: "unknown" }]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("agent:signals", [{ code: "bad" }]), { code: "INVALID_IPC_PAYLOAD" });

  assert.doesNotThrow(() => validateIpcPayload("agent:signal-update", [{ id: "sig_1", status: "closed", feedback: "useful" }]));
  assert.throws(() => validateIpcPayload("agent:signal-update", [{}]), { code: "INVALID_IPC_PAYLOAD" });
  assert.throws(() => validateIpcPayload("agent:signal-update", [{ id: "sig_1", status: "active" }]), { code: "INVALID_IPC_PAYLOAD" });

  const tsContract = loadTsContractModule();
  assert.equal(tsContract.decodePlainRecord({ ok: true }).ok, true);
  assert.throws(() => tsContract.decodePlainRecord([]), { name: "TypeError" });
  assert.deepEqual(tsContract.decodeArrayPayload([1, 2]), [1, 2]);
  assert.throws(() => tsContract.decodeArrayPayload({}), { name: "TypeError" });
});

test("ai.ipc.cjs forwards serviceRequestRuntime signal to loadAiStockProfiles in ai:rank, ai:review, and ai:custom-rank", async () => {
  const { registerAiIpc } = require("./ipc/ai.ipc.cjs");
  const handlers = new Map();
  const seenSignals = [];
  const controller = new AbortController();
  registerAiIpc({
    handleTrustedIpc: (channel, handler) => handlers.set(channel, handler),
    aiPayload: input => (input && typeof input === "object" ? input : {}),
    aiService: () => ({
      pending: () => ["600519"],
      rank: async () => ({ ranked: [] }),
      review: async () => ({ ok: true }),
      rankCustom: async () => ({ ranked: [] })
    }),
    aiProfiles: () => ({}),
    stockAgent: () => ({}),
    AI_CUSTOM_MAX: 50,
    loadAiStockProfiles: async (targets, options) => {
      seenSignals.push(options?.signal);
      return {
        profiles: targets.map(item => ({ code: String(item.code || "600519"), asOfDate: "2026-01-02" })),
        failed: []
      };
    },
    latestDate: () => "2026-01-02",
    readAiCustomList: () => [{ code: "600519", name: "样本股" }],
    normalizeAiCustomItem: x => x,
    normalizeAiCustomItems: x => x,
    isAiCustomList: () => true,
    readAiFramework: () => ({}),
    normalizeFrameworkState: x => x,
    normalizeCustom: x => x,
    frameworkCatalog: () => ({}),
    isAiFrameworkState: () => true,
    writeJson: () => {},
    settingsForService: () => ({}),
    resolveTestSecret: () => "",
    sameOrigin: () => true,
    getProfessionalReview: async () => ({}),
    recordExternalFactorSnapshot: () => {},
    createReviewSkills: () => ({}),
    getFuyaoReviewData: async () => ({}),
    getSectorStrengthBoard: async () => ({}),
    analyzeSector: async () => ({}),
    situationOf: () => [],
    emitAiStream: () => {},
    setWorkspaceAgentSnapshot: () => {},
    serviceRequestRuntime: () => ({ signal: controller.signal })
  });

  await handlers.get("ai:rank")({}, { picks: [{ code: "600519", name: "样本股" }] });
  await handlers.get("ai:review")({}, { security: { code: "600519", name: "样本股" } });
  await handlers.get("ai:custom-rank")({}, {});
  assert.deepEqual(seenSignals, [controller.signal, controller.signal, controller.signal]);
});

test("M-4: ai.ipc.cjs wires abortable AbortController runtime into loadAiStockProfiles and aiService rank/review/rankCustom", async () => {
  const { registerAiIpc } = require("./ipc/ai.ipc.cjs");
  const handlers = new Map();
  const serviceCalls = [];
  const profileSignals = [];
  let cleanupCalls = 0;
  let activeController = null;

  registerAiIpc({
    handleTrustedIpc: (channel, handler) => handlers.set(channel, handler),
    aiPayload: input => (input && typeof input === "object" ? input : {}),
    aiService: () => ({
      pending: () => ["600519"],
      rank: async (_payload, runtime) => {
        serviceCalls.push({ method: "rank", runtime });
        return { ranked: [] };
      },
      review: async (_payload, runtime) => {
        serviceCalls.push({ method: "review", runtime });
        return { ok: true };
      },
      rankCustom: async (_payload, runtime) => {
        serviceCalls.push({ method: "rankCustom", runtime });
        return { ranked: [] };
      }
    }),
    aiProfiles: () => ({}),
    stockAgent: () => ({}),
    AI_CUSTOM_MAX: 50,
    loadAiStockProfiles: async (targets, options) => {
      profileSignals.push(options?.signal);
      if (options?.signal?.aborted) throw options.signal.reason;
      return {
        profiles: targets.map(item => ({ code: String(item.code || "600519"), asOfDate: "2026-01-02" })),
        failed: []
      };
    },
    latestDate: () => "2026-01-02",
    readAiCustomList: () => [{ code: "600519", name: "样本股" }],
    normalizeAiCustomItem: x => x,
    normalizeAiCustomItems: x => x,
    isAiCustomList: () => true,
    readAiFramework: () => ({}),
    normalizeFrameworkState: x => x,
    normalizeCustom: x => x,
    frameworkCatalog: () => ({}),
    isAiFrameworkState: () => true,
    writeJson: () => {},
    settingsForService: () => ({}),
    resolveTestSecret: () => "",
    sameOrigin: () => true,
    getProfessionalReview: async () => ({}),
    recordExternalFactorSnapshot: () => {},
    createReviewSkills: () => ({}),
    getFuyaoReviewData: async () => ({}),
    getSectorStrengthBoard: async () => ({}),
    analyzeSector: async () => ({}),
    situationOf: () => [],
    emitAiStream: () => {},
    setWorkspaceAgentSnapshot: () => {},
    serviceRequestRuntime: (_event, input) => ({ owner: 42, requestId: input?.requestId }),
    trackAbortableRequest: () => {
      const controller = new AbortController();
      activeController = controller;
      return {
        signal: controller.signal,
        abort: reason => controller.abort(reason),
        cleanup: () => { cleanupCalls += 1; }
      };
    }
  });

  await handlers.get("ai:rank")({}, { requestId: "req-1", picks: [{ code: "600519", name: "样本股" }] });
  await handlers.get("ai:review")({}, { requestId: "req-2", security: { code: "600519", name: "样本股" } });
  await handlers.get("ai:custom-rank")({}, { requestId: "req-3" });

  assert.equal(serviceCalls.length, 3);
  assert.equal(cleanupCalls, 3);
  for (let i = 0; i < 3; i += 1) {
    assert.equal(serviceCalls[i].runtime.owner, 42);
    assert.equal(serviceCalls[i].runtime.requestId, `req-${i + 1}`);
    assert.equal(serviceCalls[i].runtime.signal, profileSignals[i]);
    assert.equal(serviceCalls[i].runtime.signal instanceof AbortSignal, true);
  }

  // Aborting in-flight tracked controller propagates AbortError and still invokes cleanup
  const abortHandlers = new Map();
  let abortedCleanup = 0;
  registerAiIpc({
    handleTrustedIpc: (channel, handler) => abortHandlers.set(channel, handler),
    aiPayload: input => (input && typeof input === "object" ? input : {}),
    aiService: () => ({
      pending: () => ["600519"],
      rank: async () => { throw new Error("should not reach rank after abort"); }
    }),
    aiProfiles: () => ({}),
    stockAgent: () => ({}),
    AI_CUSTOM_MAX: 50,
    loadAiStockProfiles: async (_targets, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
    latestDate: () => "2026-01-02",
    readAiCustomList: () => [],
    normalizeAiCustomItem: x => x,
    normalizeAiCustomItems: x => x,
    isAiCustomList: () => true,
    readAiFramework: () => ({}),
    normalizeFrameworkState: x => x,
    normalizeCustom: x => x,
    frameworkCatalog: () => ({}),
    isAiFrameworkState: () => true,
    writeJson: () => {},
    settingsForService: () => ({}),
    resolveTestSecret: () => "",
    sameOrigin: () => true,
    getProfessionalReview: async () => ({}),
    recordExternalFactorSnapshot: () => {},
    createReviewSkills: () => ({}),
    getFuyaoReviewData: async () => ({}),
    getSectorStrengthBoard: async () => ({}),
    analyzeSector: async () => ({}),
    situationOf: () => [],
    emitAiStream: () => {},
    setWorkspaceAgentSnapshot: () => {},
    serviceRequestRuntime: (_event, input) => ({ owner: 42, requestId: input?.requestId }),
    trackAbortableRequest: () => {
      activeController = new AbortController();
      return {
        signal: activeController.signal,
        abort: reason => activeController.abort(reason),
        cleanup: () => { abortedCleanup += 1; }
      };
    }
  });
  const pendingRank = abortHandlers.get("ai:rank")({}, { requestId: "req-abort", picks: [{ code: "600519", name: "样本股" }] });
  activeController.abort(Object.assign(new Error("任务已取消"), { code: "JOB_CANCELLED", name: "AbortError" }));
  await assert.rejects(pendingRank, { code: "JOB_CANCELLED" });
  assert.equal(abortedCleanup, 1);
});
